import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';

export class Installer {
    static getSudo(): string {
        try {
            execSync('sudo -n true', { stdio: 'ignore' });
            return 'sudo ';
        } catch (e) {
            if (process.getuid && process.getuid() === 0) {
                return '';
            }
            return 'sudo ';
        }
    }

    static installSystemDependency(depName: string): boolean {
        const sudo = this.getSudo();
        console.log(`\x1b[33m[Installer] Installing ${depName}...\x1b[0m`);
        
        try {
            let command = '';
            const lowerDep = depName.toLowerCase();

            if (this.checkCommand('apt-get')) {
                switch (lowerDep) {
                    case 'redis':
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y redis-server && ${sudo}systemctl enable redis-server && ${sudo}systemctl start redis-server`;
                        break;
                    case 'mongodb':
                        const release = execSync('lsb_release -cs 2>/dev/null || echo jammy').toString().trim();
                        const supported = ['focal', 'jammy', 'noble'];
                        const target = supported.includes(release) ? release : 'jammy';
                        command = `(curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | ${sudo}gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg --yes && ` +
                                 `echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${target}/mongodb-org/7.0 multiverse" | ${sudo}tee /etc/apt/sources.list.d/mongodb-org-7.0.list && ` +
                                 `${sudo}apt-get update -y && ${sudo}apt-get install -y mongodb-org) || ` +
                                 `${sudo}apt-get install -y mongodb-server`;
                        command += ` && ${sudo}systemctl enable mongod && ${sudo}systemctl start mongod`;
                        break;
                    case 'nginx':
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y nginx && ${sudo}systemctl enable nginx && ${sudo}systemctl start nginx`;
                        break;
                    case 'ffmpeg':
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y ffmpeg`;
                        break;
                    case 'imagemagick':
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y imagemagick`;
                        break;
                    case 'certbot':
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y certbot python3-certbot-nginx`;
                        break;
                    case 'pm2':
                        command = `${sudo}npm install -g pm2`;
                        break;
                    default:
                        command = `${sudo}apt-get update -y && ${sudo}apt-get install -y ${depName}`;
                }
            } else if (this.checkCommand('brew')) {
                switch (lowerDep) {
                    case 'redis': command = `brew install redis && brew services start redis`; break;
                    case 'mongodb': command = `brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`; break;
                    case 'nginx': command = `brew install nginx && brew services start nginx`; break;
                    default: command = `brew install ${depName}`;
                }
            }

            if (command) {
                execSync(command, { stdio: 'inherit', shell: '/bin/bash' });
                return true;
            }
            return false;
        } catch (error: any) {
            console.error(`\x1b[31m[Installer] Failed to install ${depName}: ${error.message}\x1b[0m`);
            return false;
        }
    }

    static configureService(serviceName: string): boolean {
        const sudo = this.getSudo();
        console.log(`\x1b[36m[Installer] Configuring ${serviceName}...\x1b[0m`);
        try {
            switch (serviceName.toLowerCase()) {
                case 'redis':
                    execSync(`${sudo}systemctl enable redis-server && ${sudo}systemctl start redis-server`, { stdio: 'ignore' });
                    break;
                case 'mongodb':
                    execSync(`${sudo}systemctl enable mongod && ${sudo}systemctl start mongod`, { stdio: 'ignore' });
                    break;
                case 'nginx':
                    execSync(`${sudo}systemctl enable nginx && ${sudo}systemctl start nginx`, { stdio: 'ignore' });
                    break;
            }
            return true;
        } catch (e) {
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
