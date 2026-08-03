import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

export interface HealthCheckResult {
    component: string;
    status: 'ok' | 'warn' | 'error';
    message?: string;
}

export class HealthReporter {
    static display(results: HealthCheckResult[]) {
        console.log('\n\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('            SYSTEM HEALTH REPORT');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
        
        let hasError = false;
        for (const res of results) {
            let icon = '';
            let color = '';
            
            switch (res.status) {
                case 'ok':
                    icon = '✓';
                    color = '\x1b[32m';
                    break;
                case 'warn':
                    icon = '⚠';
                    color = '\x1b[33m';
                    break;
                case 'error':
                    icon = '✖';
                    color = '\x1b[31m';
                    hasError = true;
                    break;
            }
            
            const msg = res.message ? ` - ${res.message}` : '';
            console.log(`${color}${icon} ${res.component.padEnd(20)}${msg}\x1b[0m`);
        }
        
        console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');
        
        if (hasError) {
            logger.error('[Health] System startup blocked by critical failures');
            return false;
        }
        return true;
    }

    static checkFileSystem(): HealthCheckResult[] {
        const results: HealthCheckResult[] = [];
        const requiredDirs = ['logs', 'sessions', 'dist'];
        
        for (const dir of requiredDirs) {
            const fullPath = path.resolve(process.cwd(), dir);
            if (!fs.existsSync(fullPath)) {
                results.push({ component: `Dir: ${dir}`, status: 'error', message: 'Missing' });
            } else if (!fs.lstatSync(fullPath).isDirectory()) {
                results.push({ component: `Dir: ${dir}`, status: 'error', message: 'Not a directory' });
            } else {
                results.push({ component: `Dir: ${dir}`, status: 'ok' });
            }
        }
        
        return results;
    }
}
