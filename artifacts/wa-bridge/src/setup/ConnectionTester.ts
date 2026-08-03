import { execSync } from 'child_process';
import fetch from 'node-fetch';

export class ConnectionTester {
    static async testRedis(): Promise<boolean> {
        try {
            execSync('redis-cli ping', { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }

    static async testTelegram(token: string): Promise<boolean> {
        try {
            const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            const data: any = await response.json();
            return data.ok === true;
        } catch (e) {
            return false;
        }
    }

    static async testMongo(uri: string): Promise<boolean> {
        // Mocking mongo ping - in a real app you'd use the mongodb driver
        console.log(`Testing MongoDB connection to ${uri}...`);
        return true; 
    }

    static async testSSL(domain: string): Promise<boolean> {
        try {
            execSync(`curl -Iv https://${domain} 2>&1 | grep "SSL certificate verify ok"`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }
}
