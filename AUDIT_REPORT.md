# OMEGA-V1 SETUP & STARTUP AUDIT REPORT

## 1. Root Cause of Node REPL Issue
The terminal ends up in the Node REPL because the root `setup` script (bash) and the internal `setup` script (`run.ts`) both exit upon completion. In many environments (like Replit or custom bootloaders), when a script finishes, the environment may default to the language's interactive shell if no other process is running. 

**Fix:** The setup process must conclude by explicitly launching the application (e.g., `npm start`) instead of exiting to the shell.

## 2. Startup Pipeline Weaknesses
- **Root `setup` script fallbacks:** The use of `$NODE_PATH "$NPM_PATH" exec ...` is non-standard and fragile. If `$NPM_PATH` is empty, it may lead to unexpected behavior.
- **Missing Build Step:** The root `setup` script does not ensure the project is built (`pnpm build`) before finishing, which can lead to `node dist/index.js` failing if the user tries to start it manually.
- **Entrypoint Mismatch:** `src/index.ts` requires `TELEGRAM_OWNER_ID`, but the emergency `env-prompt.ts` only asks for `TELEGRAM_BOT_TOKEN`. This causes a crash immediately after the emergency prompt.

## 3. Setup Wizard Audit
- **Dependency Detection:** Current detection is shallow (only checks `--version`). It doesn't handle missing dependencies gracefully (no options to install or use remote alternatives).
- **Validation:**
    - MongoDB URI is not validated.
    - Redis URL is not validated.
    - Many optional fields have no validation.
- **Persistence:** No "resume" logic if setup is interrupted.
- **Connectivity Testing:**
    - MongoDB test is a hardcoded `true` stub.
    - Redis test depends on `redis-cli` being in PATH, which might not be true even if Redis is running.

## 4. Environment & Build Validation
- **Missing Assets:** No check for `fonts`, `templates`, or `menus` directories before startup.
- **Env Variable Sanitization:** No protection against `undefined`, `null`, or empty strings beyond basic truthiness checks.

## 5. Error Handling & Auto-Recovery
- **Stack Traces:** The application still throws raw errors in several places (e.g., `index.ts` line 69).
- **Recovery:** Limited auto-reconnect logic for Redis/MongoDB during the initial boot phase.

---
## Proposed Action Plan
1.  **Refactor Root `setup` script:** Clean up fallbacks and add a "Start Bot" step at the end.
2.  **Unify Env Requirements:** Sync `env-prompt.ts` and `index.ts` requirements.
3.  **Enhance `DependencyChecker`:** Add support for all requested tools and interactive "what to do" prompts.
4.  **Improve `ConnectionTester`:** Implement real MongoDB testing and robust Redis testing.
5.  **Add Build Validation:** Check for `dist` and required assets in `index.ts`.
6.  **Pretty Error Reports:** Create a `HealthReporter` to display clean startup status.
