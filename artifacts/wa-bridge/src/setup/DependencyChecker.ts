import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class DependencyChecker {
    /**
     * Checks if a command exists in the system PATH.
     */
    static checkCommand(command: string): boolean {
        try {
            // Use 'command -v' or 'which' for more reliable detection across platforms
            const checkCmd = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
            execSync(checkCmd, { stdio: 'ignore' });
            return true;
        } catch (e) {
            // Fallback to --version check
            try {
                execSync(`${command} --version`, { stdio: 'ignore' });
                return true;
            } catch (e2) {
                return false;
            }
        }
    }

    static checkFile(filePath: string): boolean {
        return fs.existsSync(path.resolve(process.cwd(), filePath));
    }

    static checkDirectory(dirPath: string): boolean {
        const fullPath = path.resolve(process.cwd(), dirPath);
        return fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory();
    }

    /**
     * Checks if Redis is available either locally via CLI or as a service.
     */
    static checkRedis(): boolean {
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
     * Checks if MongoDB is available (checks for mongod or mongo shell).
     */
    static checkMongo(): boolean {
        return this.checkCommand('mongod') || this.checkCommand('mongosh') || this.checkCommand('mongo');
    }

    static checkPermissions(filePath: string): boolean {
        try {
            fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Returns a list of missing dependencies from the provided list.
     */
    static checkMissingDependencies(deps: string[]): string[] {
        const missing: string[] = [];
        for (const dep of deps) {
            let exists = false;
            if (dep === 'redis') {
                exists = this.checkRedis();
            } else if (dep === 'mongodb') {
                exists = this.checkMongo();
            } else {
                exists = this.checkCommand(dep);
            }
            
            if (!exists) {
                missing.push(dep);
            }
        }
        return missing;
    }
}
