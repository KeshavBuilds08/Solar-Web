/**
 * Circuitech Authentication Controller
 * Manages form lifecycle, visual cues, live password entropy analysis, and UI notifications.
 */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', initAuth);

  function initAuth() {
    updateGlobalNavAuth();
    setupPasswordToggles();

    // Check for restricted access notification
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('restricted') === '1') {
      const errorBanner = document.getElementById('auth-error-banner');
      if (errorBanner) {
        showBanner(errorBanner, 'Restricted Access: Live telemetry feeds and actuator controls require an active authenticated operator session.');
      }
    }

    setupCloudConfigUI();

    const loginForm = document.getElementById('login-form');
    if (loginForm) setupLoginForm(loginForm);

    const registerForm = document.getElementById('register-form');
    if (registerForm) setupRegisterForm(registerForm);
  }

  // --- Cloud Database Configuration UI ---
  function setupCloudConfigUI() {
    const trigger = document.getElementById('btn-toggle-cloud');
    const modal = document.getElementById('cloud-modal');
    const closeBtn = document.getElementById('btn-close-cloud');
    const saveBtn = document.getElementById('btn-save-cloud');
    const urlInput = document.getElementById('supabase-url');
    const keyInput = document.getElementById('supabase-key');
    const statusIndicator = document.getElementById('cloud-status-indicator');

    function updateIndicator() {
      if (!statusIndicator) return;
      const isCloud = window.SecurityDB && window.SecurityDB.isCloudActive();
      statusIndicator.textContent = isCloud ? 'Supabase Cloud (PostgreSQL)' : 'Local Encrypted';
      statusIndicator.style.color = isCloud ? '#10b981' : '#f59e0b';
    }

    updateIndicator();

    if (trigger && modal) {
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        const conf = window.SecurityDB.getCloudConfig();
        if (urlInput) urlInput.value = conf.url || '';
        if (keyInput) keyInput.value = conf.anonKey || '';
        modal.style.display = 'flex';
      });

      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          modal.style.display = 'none';
        });
      }

      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
      });

      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          const url = (urlInput.value || '').trim();
          const key = (keyInput.value || '').trim();
          const success = window.SecurityDB.setCloudConfig(url, key);
          modal.style.display = 'none';
          updateIndicator();
          alert(success ? 'Supabase Cloud Connected! Accounts are now synchronized globally across all devices.' : 'Switched to Local Encrypted Database mode.');
        });
      }
    }
  }

  // --- Global Navigation Status Updater ---
  function updateGlobalNavAuth() {
    const session = window.SecurityDB ? window.SecurityDB.getSession() : null;
    const authContainer = document.getElementById('nav-auth-container');
    if (!authContainer) return;

    if (session) {
      authContainer.innerHTML = `
        <div class="nav-user">
          <span class="nav-user-name">${escapeHTML(session.name)}</span>
          <a href="dashboard.html" class="nav-auth btn-solid" style="padding:6px 14px; font-size:0.8rem;">Console</a>
          <button id="btn-global-logout" class="btn-logout">Exit Session</button>
        </div>
      `;
      const logoutBtn = document.getElementById('btn-global-logout');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
          window.SecurityDB.logout();
          window.location.href = 'login.html';
        });
      }
    }
  }

  // --- Password Visibility Toggle ---
  function setupPasswordToggles() {
    const toggleButtons = document.querySelectorAll('.toggle-password');
    toggleButtons.forEach(btn => {
      btn.addEventListener('click', function () {
        const input = this.parentElement.querySelector('input');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';

        // Toggle SVG stroke or styling
        this.innerHTML = isPassword ? `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        ` : `
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      });
    });
  }

  // --- Login Handler ---
  function setupLoginForm(form) {
    const emailInput = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const submitBtn = document.getElementById('login-submit');
    const errorBanner = document.getElementById('auth-error-banner');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      hideBanner(errorBanner);

      const email = emailInput.value.trim();
      const password = passwordInput.value;

      if (!email || !password) {
        showBanner(errorBanner, 'Please provide both your registered email and password.');
        return;
      }

      setLoading(submitBtn, true);

      try {
        await window.SecurityDB.login(email, password);
        const card = document.querySelector('.auth-card');
        if (card) card.classList.add('success-state');

        // Smooth redirect
        setTimeout(() => {
          const params = new URLSearchParams(window.location.search);
          const next = params.get('next') || 'dashboard.html';
          window.location.href = next;
        }, 600);
      } catch (err) {
        setLoading(submitBtn, false);
        showBanner(errorBanner, err.message || 'Authentication failed. Please verify your credentials.');
        passwordInput.value = '';
        passwordInput.focus();
      }
    });
  }

  // --- Register Handler ---
  function setupRegisterForm(form) {
    const nameInput = document.getElementById('reg-name');
    const emailInput = document.getElementById('reg-email');
    const passwordInput = document.getElementById('reg-password');
    const confirmInput = document.getElementById('reg-confirm');
    const submitBtn = document.getElementById('reg-submit');
    const errorBanner = document.getElementById('auth-error-banner');
    const successBanner = document.getElementById('auth-success-banner');

    const strengthFill = document.getElementById('strength-fill');
    const strengthText = document.getElementById('strength-text');

    if (passwordInput && strengthFill && strengthText) {
      passwordInput.addEventListener('input', function () {
        const val = this.value;
        const score = computeStrength(val);
        updateStrengthUI(score, strengthFill, strengthText);
      });
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      hideBanner(errorBanner);
      hideBanner(successBanner);

      const name = nameInput.value.trim();
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      const confirm = confirmInput.value;

      if (!name || !email || !password || !confirm) {
        showBanner(errorBanner, 'All registration fields are required.');
        return;
      }

      if (password !== confirm) {
        showBanner(errorBanner, 'Entered passwords do not match.');
        confirmInput.classList.add('error');
        return;
      } else {
        confirmInput.classList.remove('error');
      }

      if (password.length < 8) {
        showBanner(errorBanner, 'Password length must be at least 8 characters.');
        return;
      }

      setLoading(submitBtn, true);

      try {
        await window.SecurityDB.register(name, email, password);
        showBanner(successBanner, 'Account registered successfully. Encrypting and redirecting to telemetry console...');
        const card = document.querySelector('.auth-card');
        if (card) card.classList.add('success-state');

        setTimeout(() => {
          const params = new URLSearchParams(window.location.search);
          const next = params.get('next') || 'dashboard.html';
          window.location.href = next;
        }, 1200);
      } catch (err) {
        setLoading(submitBtn, false);
        showBanner(errorBanner, err.message || 'Could not register user. Please try again.');
      }
    });
  }

  // --- Strength Calculator ---
  function computeStrength(pwd) {
    if (!pwd) return 0;
    let score = 0;
    if (pwd.length >= 8) score++;
    if (pwd.length >= 12) score++;
    if (/[A-Z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    return Math.min(score, 4);
  }

  function updateStrengthUI(score, fill, text) {
    fill.className = 'strength-fill';
    switch (score) {
      case 0:
      case 1:
        fill.classList.add('weak');
        text.textContent = 'Password strength: Vulnerable';
        text.style.color = '#ef4444';
        break;
      case 2:
        fill.classList.add('fair');
        text.textContent = 'Password strength: Fair';
        text.style.color = '#f59e0b';
        break;
      case 3:
        fill.classList.add('good');
        text.textContent = 'Password strength: Good';
        text.style.color = '#3b82f6';
        break;
      case 4:
        fill.classList.add('strong');
        text.textContent = 'Password strength: Cryptographically Robust';
        text.style.color = '#10b981';
        break;
    }
  }

  // --- UI Helpers ---
  function setLoading(btn, isLoading) {
    if (!btn) return;
    if (isLoading) {
      btn.classList.add('loading');
      btn.disabled = true;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  function showBanner(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
  }

  function hideBanner(el) {
    if (!el) return;
    el.classList.remove('visible');
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

})();
