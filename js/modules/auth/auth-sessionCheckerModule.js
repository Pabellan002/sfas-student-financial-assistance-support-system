import AppPaths from '../../services/services-appPaths.js';
import apiService from "../../services/services-apiService.js";
import { showSessionReplacementNotice } from './auth-sessionReplacement.js';

class SessionChecker {
  constructor() {
    this.isAuthenticated = false;
    this.userData = null;
    this.checkInterval = null;
    this.isChecking = false;
    this.redirected = false; // Prevent multiple redirects
    this.debug = true; // Enable debugging logs (set to false in production)

    // Make SessionChecker globally accessible
    window.sessionChecker = this;
  }

  async init() {
    try {
      this.addLoadingOverlay();
      const isAuthenticated = await this.checkSession();
      if (!isAuthenticated) {
        this.redirectToLogin("init_not_authenticated");
        return;
      }
      this.removeLoadingOverlay();
      this.checkInterval = setInterval(() => {
        this.checkSession();
      }, 120000); // 2 minutes

      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.checkSession();
      });
    } catch (error) {
      this.redirectToLogin("init_error");
    }
  }

  async ensureActive() {
    // Retry once shortly after load to avoid race right after login redirect
    const ok = await this.checkSession();
    if (!ok) {
      await new Promise(r => setTimeout(r, 300));
      return this.checkSession();
    }
    return ok;
  }

  async checkSession() {
    if (this.isChecking) return this.isAuthenticated;
    this.isChecking = true;
    try {
      const data = await apiService.get("/auth/auth-check-session.php");
      if (this.debug) {
        // Debug mode enabled
      }
      if (data.success && (data.authenticated === true || data.active === true)) {
        this.isAuthenticated = true;
        this.userData = data.user;
        
        // Check if password change is required
        if (data.requires_password_change === true) {
          this.redirectToLogin("password_change_required");
          return false;
        }
        
        // Store session data for RBAC in both sessionStorage and localStorage
        try {
          const sessionData = JSON.stringify({
            role_id: data.user?.role_id,
            user_id: data.user?.id,
            user_name: data.user?.name,
            role_name: data.user?.role_name,
            user_type: data.user?.type
          });
          sessionStorage.setItem('user_session', sessionData);
          localStorage.setItem('user_session', sessionData);
        } catch (e) {
          console.error('Failed to store session data:', e);
        }
        
        this.updateUI(data.user || {});
        this.enforceRoleRoute();
        return true;
      } else {
        this.isAuthenticated = false;
        this.userData = null;
        this.redirectToLogin(data?.reason === "signed_in_elsewhere" ? "signed_in_elsewhere" : "checkSession_inactive");
        return false;
      }
    } catch (error) {
      this.isAuthenticated = false;
      this.userData = null;
      this.redirectToLogin("checkSession_error");
      return false;
    } finally {
      this.isChecking = false;
    }
  }

  enforceRoleRoute() {
    if (!this.userData) {
      return;
    }
    
    // Prevent multiple redirects
    if (this.redirected) {
      return;
    }
    
    const role = (this.userData.role_name || "").toLowerCase();
    const userType = (this.userData.type || "").toLowerCase();
    const roleId = this.userData.role_id;
    const path = AppPaths.portalPath();

    // Students should only access student pages
    if (role === "student" || userType === "student") {
      if (!/\/views\/students\//.test(path)) {
        window.location.replace(AppPaths.page('views/students/students-dashboard.html'));
      }
      return;
    }
    
    // Map role IDs to their home dashboards
    const dashboardMap = {
      97: AppPaths.page('views/coo/coo-dashboard.html'),
      98: AppPaths.page('views/branch-admin/branch-admin-dashboard.html'),
      99: AppPaths.page('views/cashier/cashier-dashboard.html'),
      100: AppPaths.page('views/csdl/csdl-dashboard.html'),
      101: AppPaths.page('views/assessment/assessment-dashboard.html')
    };

    // Non-students should not access student pages - redirect to their appropriate dashboard
    if (/\/views\/students\//.test(path)) {
      const targetDashboard = dashboardMap[roleId] || AppPaths.page('views/csdl/csdl-dashboard.html');
      window.location.replace(targetDashboard);
      return;
    }

    // Enforce that employees stay in their own module.
    const moduleRoutes = [
      // CSDL module - only CSDL Admin
      { pattern: /\/views\/csdl\//,          allowedRoles: [100] },
      // Assessment module - Assessment PN-tagging staff + CSDL Admin
      { pattern: /\/views\/assessment\//,    allowedRoles: [101, 100] },
      // Branch Admin module
      { pattern: /\/views\/branch-admin\//,  allowedRoles: [98] },
      // COO module
      { pattern: /\/views\/coo\//,           allowedRoles: [97] },
      // Cashier module - Cashier financial-review staff + CSDL Admin
      { pattern: /\/views\/cashier\//,       allowedRoles: [99, 100] }
    ];

    for (const route of moduleRoutes) {
      if (route.pattern.test(path)) {
        const allowed = route.allowedRoles || [];
        if (!allowed.includes(roleId)) {
          const targetDashboard = dashboardMap[roleId] || AppPaths.page('views/csdl/csdl-dashboard.html');
          window.location.replace(targetDashboard);
        }
        break;
      }
    }
  }

  updateUI(user) {
    const headerAvatar =
      document.getElementById("headerUserAvatarImg") ||
      document.getElementById("headerUserAvatar");
    const headerName = document.getElementById("headerUserName");
    if (headerAvatar && user.full_name) {
      const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(
        user.full_name
      )}&background=198754&color=fff&size=32`;
      headerAvatar.src = avatarUrl;
      headerAvatar.alt = user.full_name;
    }
    if (headerName && user.full_name) headerName.textContent = user.full_name;

    const sidebarAvatar = document.getElementById("sidebarProfileAvatar");
    if (sidebarAvatar && user.full_name) {
      const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(
        user.full_name
      )}&background=198754&color=fff&size=64`;
      sidebarAvatar.src = avatarUrl;
      sidebarAvatar.alt = user.full_name;
    }
    const sidebarName = document.getElementById("sidebarProfileName");
    if (sidebarName && user.full_name) sidebarName.textContent = user.full_name;
    const sidebarRole = document.getElementById("sidebarProfileRole");
    if (sidebarRole && user.role_name) sidebarRole.textContent = user.role_name;
  }

  redirectToLogin(reason = "unknown") {
    if (this.redirected || window.__sessionReplacementNoticeShown) return;
    this.redirected = true;

    let hadStoredSessionHint = false;
    try {
      hadStoredSessionHint = !!(localStorage.getItem("user_session") || sessionStorage.getItem("user_session"));
    } catch (_) {}

    try {
      const entry = {
        ts: new Date().toISOString(),
        reason,
        path: window.location.pathname,
        userData: this.userData || null,
      };
      const raw = localStorage.getItem("session_debug_log");
      const logs = Array.isArray(JSON.parse(raw || "[]")) ? JSON.parse(raw || "[]") : [];
      logs.push(entry);
      localStorage.setItem("session_debug_log", JSON.stringify(logs.slice(-20)));
      if (this.debug) {
        // Debug mode enabled
      }
    } catch {
      // ignore logging errors
    }
    try { localStorage.removeItem("user_session"); } catch {}
    try { sessionStorage.clear(); } catch {}
    
    let loginPath = AppPaths.page('views/auth/login.html');

    // Hint login page only when client had session data but server says inactive (typical expiry).
    if (hadStoredSessionHint && reason === "checkSession_inactive") {
      const sep = loginPath.includes("?") ? "&" : "?";
      loginPath = `${loginPath}${sep}session_expired=1`;
    }
    this.removeLoadingOverlay();

    if (reason === "signed_in_elsewhere") {
      showSessionReplacementNotice(loginPath);
      return;
    }

    const go = () => window.location.replace(loginPath);

    if (reason === "password_change_required" && typeof Swal !== "undefined") {
      Swal.fire({
        title: "Password update required",
        text: "Please sign in with your current password, then set a new one when prompted.",
        icon: "info",
        timer: 2200,
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
      }).then(go);
      return;
    }

    // Normal "not signed in" or session lost: go straight to login (no alarming "Access Denied" flash).
    const silentReasons = new Set([
      "init_not_authenticated",
      "checkSession_inactive",
      "init_error",
      "checkSession_error",
    ]);
    if (silentReasons.has(reason)) {
      go();
      return;
    }

    if (typeof Swal !== "undefined") {
      Swal.fire({
        title: "Sign in required",
        text: "Please log in to continue.",
        icon: "info",
        timer: 1200,
        showConfirmButton: false,
        allowOutsideClick: false,
        allowEscapeKey: false,
      }).then(go);
    } else {
      go();
    }
  }

  addLoadingOverlay() {
    if (document.getElementById("sessionCheckOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "sessionCheckOverlay";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.95);display:flex;justify-content:center;align-items:center;z-index:9999;";
    overlay.innerHTML =
      '<div class="text-center"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2 text-muted">Checking authentication...</p></div>';
    document.body.appendChild(overlay);
  }

  removeLoadingOverlay() {
    const overlay = document.getElementById("sessionCheckOverlay");
    if (overlay) overlay.remove();
  }

  destroy() {
    if (this.checkInterval) clearInterval(this.checkInterval);
  }

  getBaseURL() {
        return AppPaths.apiBase;
    }
}

export default SessionChecker;
