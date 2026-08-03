import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class DependencyChecker {
    /**
     * Checks if a command exists in the system PATH.
     */
    static checkCommand(command: string): boolean {
        try {
            const checkCmd = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
            execSync(checkCmd, { stdio: 'ignore' });
            return true;
        } catch (e) {
            try {
                execSync(`${command} --version`, { stdio: 'ignore' });
                return true;
            } catch (e2) {
                return false;
            }
        }
    }

    static checkService(serviceName: string): boolean {
        try {
            if (process.platform === 'win32') return false;
            execSync(`systemctl is-active --quiet ${serviceName}`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            try {
                execSync(`service ${serviceName} status`, { stdio: 'ignore' });
                return true;
            } catch (e2) {
                return false;
            }
        }
    }

    /**
     * Checks if Redis is available and running.
     */
    static checkRedis(): boolean {
        if (this.checkService('redis-server') || this.checkService('redis')) return true;
        if (this.checkCommand('redis-cli')) {
            try {
                const output = execSync('redis-cli ping', { encoding: 'utf8', timeout: 2000 }).trim();
                return output === 'PONG';
            } catch (e) {
                return false;
            }
        }
        return false;
    }

    /**
     * Checks if MongoDB is available and running.
     */
    static checkMongo(): boolean {
        if (this.checkService('mongod') || this.checkService('mongodb')) return true;
        return this.checkCommand('mongod') || this.checkCommand('mongosh') || this.checkCommand('mongo');
    }

    /**
     * Checks if Nginx is available and running.
     */
    static checkNginx(): boolean {
        return this.checkCommand('nginx') && (this.checkService('nginx'));
    }

    /**
     * Returns a list of missing dependencies from the provided list.
     */
    static getMissingDependencies(deps: string[]): string[] {
        const missing: string[] = [];
        for (const dep of deps) {
            let exists = false;
            const lowerDep = dep.toLowerCase();
            
            if (lowerDep === 'redis') {
                exists = this.checkRedis();
            } else if (lowerDep === 'mongodb') {
                exists = this.checkMongo();
            } else if (lowerDep === 'nginx') {
                exists = this.checkNginx();
            } else if (lowerDep === 'imagemagick') {
                exists = this.checkCommand('magick') || this.checkCommand('convert');
            } else {
                exists = this.checkCommand(dep);
            }
            
            if (!exists) {
                missing.push(dep);
            }
        }
        return missing;
    }

    /**
     * Automatically detect workspace root and bot package info.
     */
    static detectWorkspaceInfo() {
        let current = process.cwd();
        let root = current;
        
        // Find workspace root (has pnpm-workspace.yaml or .git)
        for (let i = 0; i < 5; i++) {
            if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(current, '.git'))) {
                root = current;
                break;
            }
            current = path.dirname(current);
        }

        const botPackagePath = path.join(root, 'artifacts/wa-bridge');
        const hasBotPackage = fs.existsSync(botPackagePath);

        return {
            root,
            botPackagePath: hasBotPackage ? botPackagePath : current,
            isWorkspace: fs.existsSync(path.join(root, 'pnpm-workspace.yaml'))
        };
    }
}
