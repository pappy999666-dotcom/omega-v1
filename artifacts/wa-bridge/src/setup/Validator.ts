import net from 'net';
import { execSync } from 'child_process';

export class Validator {
    static isNumeric(value: string): boolean {
        return /^\d+$/.test(value);
    }

    static isTelegramToken(value: string): boolean {
        // Broaden regex to match typical Telegram bot tokens
        return /^\d+:[\w-]{30,50}$/.test(value);
    }

    static async isPortAvailable(port: string): Promise<boolean> {
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) return false;
        
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(portNum);
        });
    }

    static isNonEmpty(value: string): boolean {
        return value.trim().length > 0;
    }

    static isValidDomain(value: string): boolean {
        return /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,11}?$/.test(value);
    }

    static checkDNS(domain: string): boolean {
        try {
            execSync(`nslookup ${domain}`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }
}
