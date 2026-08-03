import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export class DependencyChecker {
    static checkCommand(command: string): boolean {
        try {
            execSync(`${command} --version`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }

    static checkFile(filePath: string): boolean {
        return fs.existsSync(path.resolve(process.cwd(), filePath));
    }

    static checkDirectory(dirPath: string): boolean {
        const fullPath = path.resolve(process.cwd(), dirPath);
        return fs.existsSync(fullPath) && fs.lstatSync(fullPath).isDirectory();
    }

    static checkRedis(): boolean {
        try {
            execSync('redis-cli ping', { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }

    static checkPermissions(filePath: string): boolean {
        try {
            fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
            return true;
        } catch (e) {
            return false;
        }
    }

    static checkMissingDependencies(deps: string[]): string[] {
        const missing: string[] = [];
        for (const dep of deps) {
            if (!this.checkCommand(dep)) {
                missing.push(dep);
            }
        }
        return missing;
    }
}
