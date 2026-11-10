/**
 * RBAC Utility Module
 * Handles permission checking on the client side
 */

class RBACUtil {
    constructor() {
        this.permissions = null;
        this.userRole = null;
        this.loadingPromise = null;
    }
    
    async init() {
        if (Array.isArray(this.permissions)) return;
        if (this.loadingPromise) return this.loadingPromise;

        this.loadingPromise = (async () => {
            try {
                const sessionData = sessionStorage.getItem('user_session') || localStorage.getItem('user_session');
                const session = JSON.parse(sessionData);
                this.userRole = session.role_id;
            } catch (_) {
                this.userRole = null;
            }

            const initial = document.getElementById('rbac-initial-permissions');
            if (initial) {
                try {
                    const permissions = JSON.parse(initial.textContent);
                    if (Array.isArray(permissions)) {
                        this.permissions = permissions;
                        return;
                    }
                } catch (_) {}
            }
            await this.loadPermissions();
        })();
        try {
            await this.loadingPromise;
        } finally {
            this.loadingPromise = null;
        }
    }

    async loadPermissions() {
        try {
            const response = await fetch('../../api/masterfiles/masterfiles-permissions.php?action=get_my_permissions', {
                method: 'GET',
                credentials: 'include'
            });
            const data = await response.json();
            
            if (!response.ok || !data?.success || !Array.isArray(data.permissions)) {
                throw new Error('Unable to load current permissions');
            }
            this.permissions = data.permissions;
        } catch (error) {
            if (!Array.isArray(this.permissions)) throw error;
        }
    }

    hasPermission(permissionKey) {
        if (!Array.isArray(this.permissions)) {
            return false;
        }

        // The parent Masterfiles grant is required for every child page/action.
        if (permissionKey.startsWith('csdl.masterfiles.')
            && permissionKey !== 'csdl.masterfiles.access'
            && permissionKey !== 'csdl.masterfiles.manage'
            && !this.hasPermission('csdl.masterfiles.access')) {
            return false;
        }

        const perm = this.permissions.find(p => p.permission_key === permissionKey);
        if (perm) {
            return Number(perm.is_granted) === 1;
        }

        // Legacy Manage Masterfiles grants child permissions unless explicitly denied.
        if (
            permissionKey.startsWith('csdl.masterfiles.')
            && permissionKey !== 'csdl.masterfiles.manage'
            && permissionKey !== 'csdl.masterfiles.access'
        ) {
            const manage = this.permissions.find(p => p.permission_key === 'csdl.masterfiles.manage');
            if (manage && Number(manage.is_granted) === 1) {
                return true;
            }
        }

        return false;
    }

    canAccessPage(pageKey) {
        return this.hasPermission(pageKey);
    }

    canPerformAction(actionKey) {
        return this.hasPermission(actionKey);
    }

    // Hide/show sidebar menu items based on permissions
    applySidebarPermissions() {
        const menuItems = [
            { selector: 'a[href*="csdl-dashboard"]', permission: 'csdl.dashboard.access' },
            { selector: 'a[data-section="overview"]', permission: 'csdl.dashboard.access' },
            { selector: 'a[href*="csdl-loans-management"]', permission: 'csdl.loans.access' },
            { selector: 'a[href*="csdl-pn-tagging"]', permission: 'csdl.pntagging.access' },
            { selector: 'a[href*="csdl-settings"]', permission: 'csdl.settings.access' },
            
            // Masterfiles parent menu item (the collapsible toggle)
            { selector: 'a[data-bs-toggle="collapse"][href="#masterfilesMenu"]', permission: 'csdl.masterfiles.access' },
            
            // Individual Masterfiles pages
            { selector: 'a[href*="masterfiles-employees"]', permission: 'csdl.masterfiles.employees.access' },
            { selector: 'a[href*="masterfiles-students"]', permission: 'csdl.masterfiles.students.access' },
            { selector: 'a[href*="masterfiles-campuses"]', permission: 'csdl.masterfiles.campuses.access' },
            { selector: 'a[href*="masterfiles-departments"]', permission: 'csdl.masterfiles.departments.access' },
            { selector: 'a[href*="masterfiles-scholarships"]', permission: 'csdl.masterfiles.scholarships.access' },
            { selector: 'a[href*="masterfiles-school-years"]', permission: 'csdl.masterfiles.school_years.access' },
            { selector: 'a[href*="masterfiles-year-levels"]', permission: 'csdl.masterfiles.year_levels.access' },
            { selector: 'a[href*="masterfiles-modalities"]', permission: 'csdl.masterfiles.modalities.access' },
            { selector: 'a[href*="masterfiles-documents"]', permission: 'csdl.masterfiles.documents.access' },
            { selector: 'a[href*="masterfiles-programs"]', permission: 'csdl.masterfiles.programs.access' },
            
            { selector: 'a[href*="finance-dashboard"]', permission: 'finance.dashboard.access' },
            { selector: 'a[href*="finance-loans-management"]', permission: 'finance.loans.access' },
            { selector: 'a[href*="finance-balances-management"]', permission: 'finance.balances.access' },
            { selector: 'a[href*="finance-reports"]', permission: 'finance.reports.access' },
            { selector: 'a[href*="finance-settings"]', permission: 'finance.settings.access' },
            
            { selector: 'a[href*="branch-admin-dashboard"]', permission: 'branch_admin.dashboard.access' },
            { selector: 'a[href*="branch-admin-loans-mang"]', permission: 'branch_admin.loans.access' },
            { selector: 'a[href*="branch-admin-pn-tagging"]', permission: 'branch_admin.pn_tagging.access' },
            { selector: 'a[href*="branch-admin-settings"]', permission: 'branch_admin.settings.access' },
            
            { selector: 'a[href*="coo-dashboard"]', permission: 'coo.dashboard.access' },
            { selector: 'a[href*="coo-loans-management"]', permission: 'coo.loans.access' },
            { selector: 'a[href*="coo-settings"]', permission: 'coo.settings.access' },
            
            { selector: 'a[href*="assessment-dashboard"]', permission: 'assessment.dashboard.access' },
            { selector: 'a[href*="assessment-loans-management"]', permission: 'assessment.loans.access' },
            { selector: 'a[href*="assessment-balances-management"]', permission: 'assessment.balances.access' },
            { selector: 'a[href*="assessment-pn-tagging"]', permission: 'assessment.pntagging.access' },
            { selector: 'a[href*="assessment-settings"]', permission: 'assessment.settings.access' },

            { selector: 'a[href*="cashier-dashboard"]', permission: 'cashier.dashboard.access' },
            { selector: 'a[href*="cashier-loans-management"]', permission: 'cashier.loans.access' },
            { selector: 'a[href*="cashier-settings"]', permission: 'cashier.settings.access' }
        ];

        const sidebarRoot = document.getElementById('sidebarMenu');
        menuItems.forEach(item => {
            if (!sidebarRoot) return;
            // Clean public routes replace hrefs, so match the original link too.
            const legacySelector = item.selector.replaceAll('[href', '[data-legacy-href');
            sidebarRoot.querySelectorAll(`${item.selector}, ${legacySelector}`).forEach((element) => {
                const hasAccess = this.hasPermission(item.permission);
                
                const parent = element.closest('li.nav-item');
                if (parent) {
                    parent.style.display = hasAccess ? '' : 'none';
                } else {
                    element.style.display = hasAccess ? '' : 'none';
                }
            });
        });
        
        // Apply the same page permissions to CSDL's mobile navigation.
        const mobileCsdlPermissions = {
            dashboard: 'csdl.dashboard.access', loans: 'csdl.loans.access',
            pntagging: 'csdl.pntagging.access', settings: 'csdl.settings.access',
        };
        document.querySelectorAll('#csdlMobileBottomNav [data-csdl-nav]').forEach((link) => {
            const permission = mobileCsdlPermissions[link.dataset.csdlNav];
            if (permission) link.style.display = this.hasPermission(permission) ? '' : 'none';
        });

        // Special handling for Masterfiles dropdown
        // If all Masterfiles sub-items are hidden, hide the parent dropdown too
        const masterfilesParent = document.querySelector('a[data-bs-toggle="collapse"][href="#masterfilesMenu"]');
        if (masterfilesParent) {
            const masterfilesSubItems = [
                'a[href*="masterfiles-employees"]',
                'a[href*="masterfiles-students"]',
                'a[href*="masterfiles-campuses"]',
                'a[href*="masterfiles-departments"]',
                'a[href*="masterfiles-scholarships"]',
                'a[href*="masterfiles-school-years"]',
                'a[href*="masterfiles-year-levels"]',
                'a[href*="masterfiles-modalities"]',
                'a[href*="masterfiles-documents"]',
                'a[href*="masterfiles-programs"]'
            ];
            
            // Check if at least one sub-item is visible
            const hasVisibleSubItem = masterfilesSubItems.some(selector => {
                const el = document.querySelector(selector);
                if (!el) return false;
                const parent = el.closest('li.nav-item');
                const isVisible = parent ? parent.style.display !== 'none' : el.style.display !== 'none';
                return isVisible;
            });
            
            // If no sub-items are visible, hide the parent dropdown
            if (!hasVisibleSubItem) {
                const parentLi = masterfilesParent.closest('li.nav-item');
                if (parentLi) {
                    parentLi.style.display = 'none';
                }
            }
        }

        // Flat CSDL sidebar: hide the Masterfiles section label when every
        // permitted link in that specific navigation list is hidden.
        document.querySelectorAll('.csdl-sidebar-section-label--masterfiles').forEach((label) => {
            let item = label.nextElementSibling;
            let visibleLinks = false;
            while (item && !item.classList.contains('csdl-sidebar-section-label')) {
                if (item.classList.contains('nav-item') && item.style.display !== 'none' && item.querySelector('a[href]')) {
                    visibleLinks = true;
                    break;
                }
                item = item.nextElementSibling;
            }
            label.style.display = visibleLinks ? '' : 'none';
        });
        
        // Mark RBAC as applied
        document.body.setAttribute('data-rbac-applied', 'true');
        document.body.setAttribute('data-rbac-ready', 'true');
    }

    // Hide/show action buttons based on permissions
    applyActionPermissions(module) {
        const setVisible = (button, allowed) => {
            if (!button) return;
            if (!allowed) {
                button.dataset.rbacHidden = 'true';
                button.style.display = 'none';
            } else if (button.dataset.rbacHidden === 'true') {
                button.style.display = '';
                delete button.dataset.rbacHidden;
            }
        };
        // Masterfiles-specific button patterns with granular permissions
        const masterfilesButtons = [
            { id: 'addEmployeeBtn', permission: 'csdl.masterfiles.employees.create' },
            { id: 'addStudentBtn', permission: 'csdl.masterfiles.students.create' },
            { id: 'addDepartmentBtn', permission: 'csdl.masterfiles.departments.create' },
            { id: 'bulkDeleteDepartmentsBtn', permission: 'csdl.masterfiles.departments.delete' },
            { id: 'addCampusBtn', permission: 'csdl.masterfiles.campuses.create' },
            { id: 'addScholarshipBtn', permission: 'csdl.masterfiles.scholarships.create' },
            { id: 'addSchoolYearBtn', permission: 'csdl.masterfiles.school_years.create' },
            { id: 'addYearLevelBtn', permission: 'csdl.masterfiles.year_levels.create' },
            { id: 'addModalityBtn', permission: 'csdl.masterfiles.modalities.create' },
            { id: 'addProgramBtn', permission: 'csdl.masterfiles.programs.create' },
            { id: 'bulkDeleteProgramsBtn', permission: 'csdl.masterfiles.programs.delete' }
        ];

        const currentPath = window.location.pathname.toLowerCase();
        const isMasterfilePage = currentPath.includes('/masterfiles/')
            && !/(?:masterfiles-|\/)(?:year-levels)(?:\.html)?$/.test(currentPath);
        let exportPermission = `${module}.loans.view`;
        if (isMasterfilePage) {
            exportPermission = 'csdl.masterfiles.manage';
        } else if (currentPath.includes('pn-tagging')) {
            exportPermission = ['csdl', 'assessment'].includes(module)
                ? `${module}.pntagging.export` : `${module}.pn_tagging.export`;
        } else if (currentPath.includes('balances-management')) {
            exportPermission = `${module}.balances.view`;
        }

        // Masterfile exports are controlled by Manage Masterfiles. Other exports follow
        // the permission for the page that owns the data.
        const commonButtons = [
            // Student and employee masterfile import/export is a masterfile-management action,
            // not a reports action. CSDL does not have reports access by design.
            { id: 'importExportBtn', permission: 'csdl.masterfiles.manage' },
            { id: 'exportBtn', permission: exportPermission },
            { id: 'programsExportBtn', permission: exportPermission },
            { id: 'exportExcelBtn', permission: exportPermission },
            { id: 'exportPdfBtn', permission: exportPermission }
        ];

        // Module-specific buttons
        const moduleButtons = {
            'assessment': [
                { id: 'tagPnBtn', permission: 'assessment.loans.tag_pn' }
            ],
            'cashier': [
                { id: 'approveBtn', permission: 'cashier.loans.approve' }
            ],
            'csdl': [
                { id: 'approveBtn', permission: 'csdl.loans.approve' }
            ],
            'branch_admin': [
                { id: 'approveBtn', permission: 'branch_admin.loans.approve' }
            ],
            'coo': [
                { id: 'approveBtn', permission: 'coo.loans.approve' },
            ]
        };

        // Apply masterfiles buttons
        masterfilesButtons.forEach(item => {
            const btn = document.getElementById(item.id);
            setVisible(btn, this.hasPermission(item.permission));
        });

        // Apply common buttons
        commonButtons.forEach(item => {
            const btn = document.getElementById(item.id);
            setVisible(btn, this.hasPermission(item.permission));
        });

        // Apply module-specific buttons
        const specificButtons = moduleButtons[module] || [];
        specificButtons.forEach(item => {
            const btn = document.getElementById(item.id);
            setVisible(btn, this.hasPermission(item.permission));
        });

        // Hide action buttons in table rows (Edit, Delete)
        this.applyTableActionPermissions(module);
    }

    applyTableActionPermissions(module) {
        // This will be called after tables are rendered
        // For now, we'll use a MutationObserver to watch for table changes
        const observer = new MutationObserver(() => {
            this.checkTableActions(module);
        });

        // Observe table body changes
        const tables = document.querySelectorAll('tbody');
        tables.forEach(table => {
            observer.observe(table, { childList: true, subtree: true });
        });

        // Initial check
        this.checkTableActions(module);
    }

    checkTableActions(module) {
        // Determine the masterfile type from the current page URL
        const url = window.location.pathname;
        const shortMasterfile = /^\/masterfiles\/([a-z-]+)\/?$/.exec(url)?.[1] || '';
        let masterfileType = '';
        
        if (url.includes('masterfiles-employees') || shortMasterfile === 'employees') masterfileType = 'employees';
        else if (url.includes('masterfiles-students') || shortMasterfile === 'students') masterfileType = 'students';
        else if (url.includes('masterfiles-campuses') || shortMasterfile === 'campuses') masterfileType = 'campuses';
        else if (url.includes('masterfiles-departments') || shortMasterfile === 'departments') masterfileType = 'departments';
        else if (url.includes('masterfiles-scholarships') || shortMasterfile === 'scholarships') masterfileType = 'scholarships';
        else if (url.includes('masterfiles-school-years') || shortMasterfile === 'school-years') masterfileType = 'school_years';
        else if (url.includes('masterfiles-year-levels') || shortMasterfile === 'year-levels') masterfileType = 'year_levels';
        else if (url.includes('masterfiles-modalities') || shortMasterfile === 'modalities') masterfileType = 'modalities';
        else if (url.includes('masterfiles-documents') || shortMasterfile === 'documents') masterfileType = 'documents';
        else if (url.includes('masterfiles-programs') || shortMasterfile === 'programs') masterfileType = 'programs';
        
        if (masterfileType) {
            // Masterfiles-specific permissions
            const editPermission = `csdl.masterfiles.${masterfileType}.edit`;
            const deletePermission = `csdl.masterfiles.${masterfileType}.delete`;
            
            const editLinks = document.querySelectorAll('.action-edit, .programs-action-edit');
            const deleteLinks = document.querySelectorAll('.action-delete, .programs-action-delete');
            const permissionLinks = document.querySelectorAll('.action-permissions');
            
            if (!this.hasPermission(editPermission)) {
                editLinks.forEach(link => {
                    const parent = link.closest('li');
                    if (parent) parent.style.display = 'none';
                });
            }
            
            if (!this.hasPermission(deletePermission)) {
                deleteLinks.forEach(link => {
                    const parent = link.closest('li');
                    if (parent) parent.style.display = 'none';
                });
            }

            if (!this.hasPermission(editPermission)) {
                permissionLinks.forEach(link => {
                    const parent = link.closest('li');
                    if (parent) parent.style.display = 'none';
                });
            }
        } else {
            // Non-masterfiles modules - use generic permissions
            const editLinks = document.querySelectorAll('.action-edit');
            const deleteLinks = document.querySelectorAll('.action-delete');
            
            const editPermission = `${module}.manage`;
            const deletePermission = `${module}.manage`;
            
            if (!this.hasPermission(editPermission)) {
                editLinks.forEach(link => {
                    const parent = link.closest('li');
                    if (parent) parent.style.display = 'none';
                });
            }
            
            if (!this.hasPermission(deletePermission)) {
                deleteLinks.forEach(link => {
                    const parent = link.closest('li');
                    if (parent) parent.style.display = 'none';
                });
            }
        }
    }

    // Helper method to check masterfiles permissions
    canViewMasterfile(type) {
        return this.hasPermission(`csdl.masterfiles.${type}.view`);
    }

    canCreateMasterfile(type) {
        return this.hasPermission(`csdl.masterfiles.${type}.create`);
    }

    canEditMasterfile(type) {
        return this.hasPermission(`csdl.masterfiles.${type}.edit`);
    }

    canDeleteMasterfile(type) {
        return this.hasPermission(`csdl.masterfiles.${type}.delete`);
    }

    // Unified guard for masterfile actions. Returns true when allowed.
    requireMasterfilePermission(type, operation, deniedActionText = null) {
        let allowed = false;
        if (operation === 'view') {
            allowed = this.canViewMasterfile(type);
        } else if (operation === 'create') {
            allowed = this.canCreateMasterfile(type);
        } else if (operation === 'edit') {
            allowed = this.canEditMasterfile(type);
        } else if (operation === 'delete') {
            allowed = this.canDeleteMasterfile(type);
        }

        if (!allowed) {
            const actionText = deniedActionText || `${operation} ${String(type).replace('_', ' ')}`;
            this.showPermissionDenied(actionText);
            return false;
        }
        return true;
    }

    // Generic boolean-based guard for non-masterfiles modules.
    requireModulePermission(isAllowed, deniedActionText = 'perform this action') {
        if (isAllowed) return true;
        this.showPermissionDenied(deniedActionText);
        return false;
    }

    // Show permission denied message
    showPermissionDenied(action = 'perform this action') {
        if (window.Swal) {
            window.Swal.fire({
                title: 'Access Denied',
                text: `You don't have permission to ${action}.`,
                icon: 'error',
                confirmButtonColor: '#03600f'
            });
        } else {
            alert(`Access Denied: You don't have permission to ${action}.`);
        }
    }
}

// Create singleton instance
const rbacUtil = new RBACUtil();

export default rbacUtil;
