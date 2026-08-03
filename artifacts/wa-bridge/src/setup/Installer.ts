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
        console.log(`Attempting to install system dependency: ${depName}...`);
        try {
            // Check for sudo availability
            let sudo = '';
            try {
                execSync('sudo -n true', { stdio: 'ignore' });
                sudo = 'sudo ';
            } catch (e) {}

            execSync(`${sudo}apt-get update && ${sudo}apt-get install -y ${depName}`, { stdio: 'inherit' });
            return true;
        } catch (error: any) {
            console.error(`Failed to install ${depName}: ${error.message}`);
            console.log(`Please install ${depName} manually.`);
            return false;
        }
    }
}
