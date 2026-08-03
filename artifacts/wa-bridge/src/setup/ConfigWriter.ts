import fs from 'fs';
import path from 'path';

export class ConfigWriter {
    static writeEnv(config: Record<string, string>) {
        let content = '';
        for (const [key, value] of Object.entries(config)) {
            // Ensure values are properly quoted if they contain spaces or special chars
            const formattedValue = (value.includes(' ') || value.includes('"') || value.includes('$')) 
                ? JSON.stringify(value) 
                : value;
            content += `${key}=${formattedValue}\n`;
        }
        fs.writeFileSync(path.join(process.cwd(), '.env'), content);
    }

    static writeConfigJson(config: any) {
        fs.writeFileSync(
            path.join(process.cwd(), 'config.json'), 
            JSON.stringify(config, null, 4)
        );
    }

    static ensureDirectory(dirPath: string) {
        const fullPath = path.join(process.cwd(), dirPath);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
    }

    static maskSecret(secret: string): string {
        if (!secret) return 'Not set';
        if (secret.length <= 8) return '********';
        return secret.substring(0, 4) + '****' + secret.substring(secret.length - 4);
    }
}
