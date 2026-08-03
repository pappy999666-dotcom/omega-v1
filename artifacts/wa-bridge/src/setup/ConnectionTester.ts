import { execSync } from 'child_process';
import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';

export class ConnectionTester {
    static async testRedis(url?: string): Promise<boolean> {
        try {
            if (url) {
                // If we have a URL, try to use redis-cli with it
                execSync(`redis-cli -u ${url} ping`, { stdio: 'ignore', timeout: 3000 });
                return true;
            } else {
                execSync('redis-cli ping', { stdio: 'ignore', timeout: 3000 });
                return true;
            }
        } catch (e) {
            // Fallback: try to see if we can connect to the port via bash/nc if available
            try {
                const host = url ? new URL(url).hostname : 'localhost';
                const port = url ? new URL(url).port || '6379' : '6379';
                execSync(`nc -z -w 2 ${host} ${port}`, { stdio: 'ignore' });
                return true;
            } catch (e2) {
                return false;
            }
        }
    }

    static async testTelegram(token: string): Promise<boolean> {
        if (!token || !token.includes(':')) return false;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal as any });
            clearTimeout(timeout);
            const data: any = await response.json();
            return data.ok === true;
        } catch (e) {
            return false;
        }
    }

    static async testMongo(uri: string): Promise<boolean> {
        if (!uri) return false;
        console.log(`Testing MongoDB connection to ${uri}...`);
        
        // Try using mongosh or mongo if available
        const tools = ['mongosh', 'mongo'];
        for (const tool of tools) {
            try {
                execSync(`${tool} "${uri}" --eval "db.adminCommand('ping')"`, { stdio: 'ignore', timeout: 5000 });
                return true;
            } catch (e) {
                // Continue to next tool or fallback
            }
        }

        // Fallback: Simple TCP check
        try {
            const url = new URL(uri.startsWith('mongodb') ? uri : `mongodb://${uri}`);
            const host = url.hostname;
            const port = url.port || '27017';
            execSync(`nc -z -w 3 ${host} ${port}`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }

    static async testSSL(domain: string): Promise<boolean> {
        if (!domain) return false;
        try {
            // More robust check for SSL
            execSync(`curl -sIv https://${domain} 2>&1 | grep -Ei "SSL certificate verify ok|verification succeeded|OK"`, { stdio: 'ignore', timeout: 5000 });
            return true;
        } catch (e) {
            return false;
        }
    }
}
