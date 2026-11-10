<?php
/**
 * RBAC Helper Functions
 * Provides permission checking functionality
 */

class RBAC {
    private static $pdo = null;
    private static $permissionsCache = [];
    
    public static function init($pdoConnection) {
        self::$pdo = $pdoConnection;
    }

    /**
     * Check if employee has a specific permission
     * @param int $employeeId
     * @param string $permissionKey (e.g., 'finance.balances.edit')
     * @return bool
     */
    public static function hasPermission($employeeId, $permissionKey) {
        if (!self::$pdo) {
            return false;
        }

        // Check cache first
        $cacheKey = "{$employeeId}:{$permissionKey}";
        if (isset(self::$permissionsCache[$cacheKey])) {
            return self::$permissionsCache[$cacheKey];
        }
        
        try {
            $stmt = self::$pdo->prepare("
                SELECT 
                    CASE 
                        WHEN ep.employee_permission_id IS NOT NULL THEN ep.is_granted
                        WHEN rp.role_permission_id IS NOT NULL THEN 1
                        ELSE 0
                    END as has_permission,
                    CASE WHEN ep.employee_permission_id IS NOT NULL THEN 1 ELSE 0 END AS has_employee_override
                FROM tbl_csdl_employees e
                JOIN tbl_csdl_permissions p ON p.permission_key = ?
                LEFT JOIN tbl_csdl_role_permissions rp ON rp.role_id = e.employee_role_id AND rp.permission_id = p.permission_id
                LEFT JOIN tbl_csdl_employee_permissions ep ON ep.employee_id = e.employee_id AND ep.permission_id = p.permission_id
                WHERE e.employee_id = ?
                LIMIT 1
            ");
            $stmt->execute([$permissionKey, $employeeId]);
            $result = $stmt->fetch(PDO::FETCH_ASSOC);
            
            $hasPermission = $result ? (bool)$result['has_permission'] : false;
            $hasEmployeeOverride = $result ? (bool)$result['has_employee_override'] : false;

            // Every masterfile page/action also needs the parent Masterfiles grant.
            if (str_starts_with($permissionKey, 'csdl.masterfiles.')
                && !in_array($permissionKey, ['csdl.masterfiles.access', 'csdl.masterfiles.manage'], true)
                && !self::hasPermission($employeeId, 'csdl.masterfiles.access')) {
                self::$permissionsCache[$cacheKey] = false;
                return false;
            }

            // CSDL's legacy Manage Masterfiles grant provides all granular
            // masterfile actions unless this employee has an explicit denial.
            if (
                !$hasPermission
                && !$hasEmployeeOverride
                && str_starts_with($permissionKey, 'csdl.masterfiles.')
                && !in_array($permissionKey, ['csdl.masterfiles.access', 'csdl.masterfiles.manage'], true)
            ) {
                $hasPermission = self::hasPermission($employeeId, 'csdl.masterfiles.manage');
            }
            
            // Cache the result
            self::$permissionsCache[$cacheKey] = $hasPermission;
            
            return $hasPermission;
        } catch (PDOException $e) {
            error_log("RBAC Permission Check Error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Get all permissions for an employee
     * @param int $employeeId
     * @return array
     */
    public static function getEmployeePermissions($employeeId) {
        if (!self::$pdo) {
            return [];
        }
        
        try {
            $stmt = self::$pdo->prepare("
                SELECT 
                    p.permission_id,
                    p.permission_name,
                    p.permission_key,
                    p.permission_type,
                    p.permission_module,
                    CASE 
                        WHEN ep.employee_permission_id IS NOT NULL THEN ep.is_granted
                        WHEN rp.role_permission_id IS NOT NULL THEN 1
                        ELSE 0
                    END as is_granted,
                    CASE 
                        WHEN ep.employee_permission_id IS NOT NULL THEN 'employee'
                        WHEN rp.role_permission_id IS NOT NULL THEN 'role'
                        ELSE 'default'
                    END AS grant_source
                FROM tbl_csdl_employees e
                CROSS JOIN tbl_csdl_permissions p
                LEFT JOIN tbl_csdl_role_permissions rp ON rp.role_id = e.employee_role_id AND rp.permission_id = p.permission_id
                LEFT JOIN tbl_csdl_employee_permissions ep ON ep.employee_id = e.employee_id AND ep.permission_id = p.permission_id
                WHERE e.employee_id = ?
                ORDER BY p.permission_module, p.permission_type, p.permission_name
            ");
            $stmt->execute([$employeeId]);
            $permissions = $stmt->fetchAll(PDO::FETCH_ASSOC);
            self::applyMasterfilesManageInheritance($permissions);
            return $permissions;
        } catch (PDOException $e) {
            error_log("RBAC Get Permissions Error: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Put the current employee's sidebar permissions into guarded staff HTML.
     * The first paint then matches the PHP page guard, without waiting for a
     * second request that can race with page modules or fail transiently.
     */
    public static function renderStaffHtml(string $html, int $employeeId): string {
        $permissions = self::getEmployeePermissions($employeeId);
        if (!$permissions || !str_contains($html, 'id="sidebarMenu"')) {
            return $html;
        }

        $links = [
            'csdl.dashboard.access' => ['csdl-dashboard', null],
            'csdl.loans.access' => ['csdl-loans-management', null],
            'csdl.pntagging.access' => ['csdl-pn-tagging', null],
            'csdl.settings.access' => ['csdl-settings', null],
            'csdl.masterfiles.employees.access' => ['masterfiles-employees', 'csdl.masterfiles.access'],
            'csdl.masterfiles.students.access' => ['masterfiles-students', 'csdl.masterfiles.access'],
            'csdl.masterfiles.campuses.access' => ['masterfiles-campuses', 'csdl.masterfiles.access'],
            'csdl.masterfiles.departments.access' => ['masterfiles-departments', 'csdl.masterfiles.access'],
            'csdl.masterfiles.scholarships.access' => ['masterfiles-scholarships', 'csdl.masterfiles.access'],
            'csdl.masterfiles.school_years.access' => ['masterfiles-school-years', 'csdl.masterfiles.access'],
            'csdl.masterfiles.year_levels.access' => ['masterfiles-year-levels', 'csdl.masterfiles.access'],
            'csdl.masterfiles.modalities.access' => ['masterfiles-modalities', 'csdl.masterfiles.access'],
            'csdl.masterfiles.documents.access' => ['masterfiles-documents', 'csdl.masterfiles.access'],
            'csdl.masterfiles.programs.access' => ['masterfiles-programs', 'csdl.masterfiles.access'],
            'assessment.dashboard.access' => ['assessment-dashboard', null],
            'assessment.loans.access' => ['assessment-loans-management', null],
            'assessment.balances.access' => ['assessment-balances-management', null],
            'assessment.pntagging.access' => ['assessment-pn-tagging', null],
            'assessment.settings.access' => ['assessment-settings', null],
            'coo.dashboard.access' => ['coo-dashboard', null],
            'coo.loans.access' => ['coo-loans-management', null],
            'coo.settings.access' => ['coo-settings', null],
            'branch_admin.dashboard.access' => ['branch-admin-dashboard', null],
            'branch_admin.loans.access' => ['branch-admin-loans-mang', null],
            'branch_admin.pn_tagging.access' => ['branch-admin-pn-tagging', null],
            'branch_admin.settings.access' => ['branch-admin-settings', null],
            'cashier.dashboard.access' => ['cashier-dashboard', null],
            'cashier.loans.access' => ['cashier-loans-management', null],
            'cashier.settings.access' => ['cashier-settings', null],
        ];
        $hidden = [];
        foreach ($links as $key => [$slug, $parent]) {
            if (self::hasPermission($employeeId, $key)
                && (!$parent || self::hasPermission($employeeId, $parent))) continue;
            foreach (['href', 'data-legacy-href'] as $attribute) {
                $hidden[] = '#sidebarMenu li.nav-item:has(> a[' . $attribute . '*="' . $slug . '"])';
            }
        }
        if (!self::hasPermission($employeeId, 'csdl.dashboard.access')) {
            $hidden[] = '#sidebarMenu li.nav-item:has(> a[data-section="overview"])';
        }
        foreach (['dashboard' => 'csdl.dashboard.access', 'loans' => 'csdl.loans.access',
            'pntagging' => 'csdl.pntagging.access', 'settings' => 'csdl.settings.access'] as $nav => $permission) {
            if (!self::hasPermission($employeeId, $permission)) {
                $hidden[] = '#csdlMobileBottomNav [data-csdl-nav="' . $nav . '"]';
            }
        }
        $style = $hidden ? '<style id="rbac-server-sidebar">' . implode(',', $hidden) . '{display:none!important}</style>' : '';
        $json = json_encode($permissions, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
        if ($json === false) return $html;
        $bootstrap = '<script type="application/json" id="rbac-initial-permissions">' . $json . '</script>';
        $html = preg_replace('/<\/head>/i', $style . $bootstrap . '</head>', $html, 1);
        return preg_replace('/<body\b/i', '<body data-rbac-ready="true"', $html, 1);
    }
    
    /**
     * Check if employee has access to a page
     * @param int $employeeId
     * @param string $pageKey (e.g., 'finance.balances.access')
     * @return bool
     */
    public static function canAccessPage($employeeId, $pageKey) {
        return self::hasPermission($employeeId, $pageKey);
    }
    
    /**
     * Check if employee can perform an action
     * @param int $employeeId
     * @param string $actionKey (e.g., 'finance.balances.edit')
     * @return bool
     */
    public static function canPerformAction($employeeId, $actionKey) {
        return self::hasPermission($employeeId, $actionKey);
    }
    
    /**
     * Require permission or return error
     * @param int $employeeId
     * @param string $permissionKey
     * @param string $errorMessage
     */
    public static function requirePermission($employeeId, $permissionKey, $errorMessage = 'Access denied') {
        if (!self::hasPermission($employeeId, $permissionKey)) {
            http_response_code(403);
            echo json_encode(['success' => false, 'message' => $errorMessage]);
            exit;
        }
    }

    /**
     * Require at least one of the given permissions (OR).
     */
    public static function requireAnyPermission($employeeId, array $permissionKeys, $errorMessage = 'Access denied') {
        foreach ($permissionKeys as $key) {
            if (self::hasPermission($employeeId, $key)) {
                return;
            }
        }
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => $errorMessage]);
        exit;
    }

    /**
     * The granular check includes the legacy Manage Masterfiles grant when no
     * employee override exists, so an explicit denial still takes precedence.
     */
    public static function requireMasterfilesGranularOrManage($employeeId, string $granularPermissionKey, string $errorMessage = 'Access denied') {
        self::requirePermission($employeeId, $granularPermissionKey, $errorMessage);
    }

    /**
     * Read-only masterfile APIs: security pages use *.access; legacy APIs used *.view.
     * Also allow csdl.masterfiles.access so other masterfile screens can load reference lists (e.g. stats).
     *
     * @param string $moduleKey e.g. students, departments, programs, scholarships, school_years, year_levels, employees
     */
    public static function requireMasterfileRead($employeeId, string $moduleKey, string $errorMessage = 'Access denied') {
        self::requireAnyPermission($employeeId, [
            'csdl.masterfiles.access',
            'csdl.masterfiles.' . $moduleKey . '.access',
            'csdl.masterfiles.' . $moduleKey . '.view'
        ], $errorMessage);
    }

    /**
     * Applies CSDL's legacy Manage Masterfiles grant to granular permissions for
     * display and client-side checks. Explicit employee grants or denials win.
     *
     * @param array<int, array<string, mixed>> $permissions
     */
    private static function applyMasterfilesManageInheritance(array &$permissions): void {
        $hasManage = false;
        foreach ($permissions as $permission) {
            if (($permission['permission_key'] ?? '') === 'csdl.masterfiles.manage' && !empty($permission['is_granted'])) {
                $hasManage = true;
                break;
            }
        }

        if (!$hasManage) {
            return;
        }

        foreach ($permissions as &$permission) {
            $key = (string) ($permission['permission_key'] ?? '');
            $isGranularMasterfilePermission = str_starts_with($key, 'csdl.masterfiles.')
                && !in_array($key, ['csdl.masterfiles.access', 'csdl.masterfiles.manage'], true);
            if ($isGranularMasterfilePermission && ($permission['grant_source'] ?? 'default') === 'default') {
                $permission['is_granted'] = 1;
                $permission['grant_source'] = 'manage';
            }
        }
        unset($permission);
    }
}
?>
