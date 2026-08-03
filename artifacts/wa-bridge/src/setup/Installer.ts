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
            let sudo = '';
            try {
                execSync('sudo -n true', { stdio: 'ignore' });
                sudo = 'sudo ';
            } catch (e) {
                if (process.getuid && process.getuid() === 0) {
                    sudo = '';
                } else {
                    sudo = 'sudo '; 
                }
            }

            let command = '';
            
            // Specialized installation for specific engines
            switch (depName.toLowerCase()) {
                case 'redis':
                    if (this.checkCommand('apt-get')) {
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y redis-server && ${sudo}service redis-server start`;
                    } else if (this.checkCommand('brew')) {
                        command = `brew install redis && brew services start redis`;
                    }
                    break;
                case 'mongodb':
                    if (this.checkCommand('apt-get')) {
                        // Resilient MongoDB Installation Strategy
                        // 1. Try to detect a supported LTS release, default to 'jammy' (22.04) if unknown
                        const release = execSync('lsb_release -cs 2>/dev/null || echo jammy').toString().trim();
                        const supportedReleases = ['focal', 'jammy', 'noble'];
                        const targetRelease = supportedReleases.includes(release) ? release : 'jammy';
                        
                        console.log(`\x1b[36mDetected release: ${release}. Using MongoDB repo for: ${targetRelease}\x1b[0m`);
                        
                        command = `(curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | ${sudo}gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg --yes && ` +
                                 `echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${targetRelease}/mongodb-org/7.0 multiverse" | ${sudo}tee /etc/apt/sources.list.d/mongodb-org-7.0.list && ` +
                                 `${sudo}apt-get update -y && ${sudo}apt-get install -y mongodb-org) || ` +
                                 `(${sudo}apt-get update -y && ${sudo}apt-get install -y mongodb || ${sudo}apt-get install -y mongodb-server)`;
                        
                        command += ` && (${sudo}systemctl enable mongod && ${sudo}systemctl start mongod || ${sudo}service mongodb start || true)`;
                    } else if (this.checkCommand('brew')) {
                        command = `brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`;
                    }
                    break;
                case 'bun':
                    command = `curl -fsSL https://bun.sh/install | bash`;
                    break;
                case 'imagemagick':
                    if (this.checkCommand('apt-get')) {
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y imagemagick`;
                    } else if (this.checkCommand('brew')) {
                        command = `brew install imagemagick`;
                    }
                    break;
                default:
                    // Generic installation
                    if (this.checkCommand('apt-get')) {
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y ${depName}`;
                    } else if (this.checkCommand('yum')) {
                        command = `${sudo}yum install -y ${depName}`;
                    } else if (this.checkCommand('dnf')) {
                        command = `${sudo}dnf install -y ${depName}`;
                    } else if (this.checkCommand('brew')) {
                        command = `brew install ${depName}`;
                    }
            }

            if (!command) {
                throw new Error(`No installation strategy found for ${depName} on this system.`);
            }

            console.log(`Running installation sequence...`);
            execSync(command, { stdio: 'inherit', shell: '/bin/bash' });
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
