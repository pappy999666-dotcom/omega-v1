import net from 'net';
import { execSync } from 'child_process';

export class Validator {
    static isNumeric(value: string): boolean {
        return /^\d+$/.test(value);
    }

    static isTelegramToken(value: string): boolean {
        return /^\d+:[\w-]{30,50}$/.test(value);
    }

    static async isPortAvailable(port: string): Promise<boolean | string> {
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) return 'Invalid port number';
        
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve('Port is already in use'));
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(portNum);
        });
    }

    static isNonEmpty(value: string): boolean {
        return value !== undefined && value !== null && value.trim().length > 0;
    }

    static isValidDomain(value: string): boolean {
        if (value === 'localhost') return true;
        return /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,11}?$/.test(value);
    }

    static isMongoURI(value: string): boolean {
        return /^mongodb(\+srv)?:\/\/.+/.test(value);
    }

    static isRedisURL(value: string): boolean {
        return /^redis(s)?:\/\/.+/.test(value);
    }

    static checkDNS(domain: string): boolean {
        if (domain === 'localhost') return true;
        try {
            execSync(`nslookup ${domain}`, { stdio: 'ignore' });
            return true;
        } catch (e) {
            return false;
        }
    }
}
