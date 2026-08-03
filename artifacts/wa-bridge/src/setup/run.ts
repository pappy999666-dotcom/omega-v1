import { runSetupWizard } from './index.js';

runSetupWizard().catch((err) => {
    console.error('\n\x1b[31mFatal Error during setup:\x1b[0m');
    console.error(err);
    process.exit(1);
});
