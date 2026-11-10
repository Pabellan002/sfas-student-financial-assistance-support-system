/**
 * Shared Layout Initialization
 * Handles common layout functionality including RBAC
 */

import rbacUtil from './shared-rbac.js?v=20261008-server-rbac';

class LayoutInit {
    static async init() {
        // Initialize RBAC
        await rbacUtil.init();
        
        // Apply sidebar permissions
        rbacUtil.applySidebarPermissions();
        
        // Detect current module and apply action permissions
        const currentPath = window.location.pathname;
        let module = null;
        
        if (currentPath.includes('/csdl/')) {
            module = 'csdl';
        } else if (currentPath.includes('/assessment/')) {
            module = 'assessment';
        } else if (currentPath.includes('/cashier/')) {
            module = 'cashier';
        } else if (currentPath.includes('/branch-admin/')) {
            module = 'branch_admin';
        } else if (currentPath.includes('/coo/')) {
            module = 'coo';
        }
        
        if (module) {
            rbacUtil.applyActionPermissions(module);
        }
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => LayoutInit.init());
} else {
    LayoutInit.init();
}

export default LayoutInit;
export { rbacUtil };
