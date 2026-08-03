import { execSync } from 'child_process';

export class Installer {
    static installPackage(packageName: string): boolean {
        console.log(`Installing ${packageName}...`);
        try {
            let command;
            try {
                execSync('pnpm --version', { stdio: 'ignore' });
                command = `pnpm add ${packageName}`;
            } catch (e) {
                command = `npm install ${packageName}`;
            }
            
            execSync(command, { stdio: 'inherit' });
            return true;
        } catch (error: any) {
            console.error(`Failed to install ${packageName}: ${error.message}`);
            return false;
        }
    }

    static installSystemDependency(depName: string): boolean {
        console.log(`\x1b[33mAttempting to install system dependency: ${depName}...\x1b[0m`);
        try {
            // Detect package manager
            let command = '';
            let sudo = '';
            
            try {
                execSync('sudo -n true', { stdio: 'ignore' });
                sudo = 'sudo ';
            } catch (e) {
                // Check if we are already root
                if (process.getuid && process.getuid() === 0) {
                    sudo = '';
                } else {
                    console.warn('\x1b[31mWarning: No sudo access. Installation might fail.\x1b[0m');
                    sudo = 'sudo '; // Try anyway, it might prompt
                }
            }

            if (this.checkCommand('apt-get')) {
                command = `${sudo}apt-get update -y && ${sudo}apt-get install -y ${depName}`;
            } else if (this.checkCommand('yum')) {
                command = `${sudo}yum install -y ${depName}`;
            } else if (this.checkCommand('dnf')) {
                command = `${sudo}dnf install -y ${depName}`;
            } else if (this.checkCommand('brew')) {
                command = `brew install ${depName}`;
            } else {
                throw new Error('No supported package manager found (apt, yum, dnf, brew).');
            }

            console.log(`Running: ${command}`);
            execSync(command, { stdio: 'inherit' });
            return true;
        } catch (error: any) {
            console.error(`\x1b[31mFailed to install ${depName}: ${error.message}\x1b[0m`);
            console.log(`Please install ${depName} manually.`);
            return false;
        }
    }

    private static checkCommand(cmd: string): boolean {
        try {
            execSync(`command -v ${cmd}`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }
}
