import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DependencyChecker } from './DependencyChecker.js';
import { Installer } from './Installer.js';

export class DeploymentManager {
    static async configurePM2(appName: string, entryPoint: string) {
        console.log(`\x1b[36m[PM2] Configuring auto-deployment for ${appName}...\x1b[0m`);
        const sudo = Installer.getSudo();
        
        try {
            // 1. Detect entry point
            if (!fs.existsSync(entryPoint)) {
                console.log(`\x1b[31mError: Entry point ${entryPoint} not found.\x1b[0m`);
                return false;
            }

            // 2. Stop/Delete existing
            try {
                execSync(`pm2 stop ${appName}`, { stdio: 'ignore' });
                execSync(`pm2 delete ${appName}`, { stdio: 'ignore' });
            } catch (e) {}

            // 3. Start new process
            console.log(`[PM2] Starting ${appName} with entry: ${entryPoint}`);
            execSync(`pm2 start ${entryPoint} --name ${appName} --update-env --env production`, { stdio: 'inherit' });

            // 4. Save and Startup
            console.log(`[PM2] Saving process list and configuring startup...`);
            execSync(`pm2 save`, { stdio: 'inherit' });
            
            try {
                const startupOutput = execSync(`pm2 startup`, { encoding: 'utf8' });
                const command = startupOutput.split('\n').find(line => line.includes('sudo env PATH'));
                if (command) {
                    console.log(`[PM2] Executing startup command...`);
                    execSync(command.trim(), { stdio: 'inherit' });
                }
            } catch (e) {
                console.log(`\x1b[33m[PM2] Startup command already configured or failed to detect.\x1b[0m`);
            }

            console.log(`\x1b[32m✓ PM2 configured successfully.\x1b[0m`);
            return true;
        } catch (error: any) {
            console.error(`\x1b[31m[PM2] Configuration failed: ${error.message}\x1b[0m`);
            return false;
        }
    }

    static async configureNginx(domain: string, port: string, email?: string) {
        if (domain === 'localhost') return true;
        
        console.log(`\x1b[36m[Nginx] Configuring reverse proxy for ${domain}...\x1b[0m`);
        const sudo = Installer.getSudo();
        
        try {
            const config = `
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;

            const configPath = `/etc/nginx/sites-available/${domain}`;
            const enabledPath = `/etc/nginx/sites-enabled/${domain}`;

            fs.writeFileSync('./nginx_temp', config);
            execSync(`${sudo}mv ./nginx_temp ${configPath}`, { stdio: 'inherit' });
            execSync(`${sudo}ln -sf ${configPath} ${enabledPath}`, { stdio: 'inherit' });
            execSync(`${sudo}nginx -t && ${sudo}systemctl reload nginx`, { stdio: 'inherit' });

            console.log(`\x1b[32m✓ Nginx configured for ${domain}\x1b[0m`);

            if (email) {
                console.log(`\x1b[36m[SSL] Requesting Let's Encrypt certificate for ${domain}...\x1b[0m`);
                try {
                    execSync(`${sudo}certbot --nginx -d ${domain} --non-interactive --agree-tos -m ${email}`, { stdio: 'inherit' });
                    console.log(`\x1b[32m✓ HTTPS enabled for ${domain}\x1b[0m`);
                } catch (e: any) {
                    console.error(`\x1b[31m[SSL] Failed to generate certificate: ${e.message}\x1b[0m`);
                    console.log(`\x1b[33mEnsure your domain points to this VPS IP and ports 80/443 are open.\x1b[0m`);
                }
            }

            return true;
        } catch (error: any) {
            console.error(`\x1b[31m[Nginx] Configuration failed: ${error.message}\x1b[0m`);
            return false;
        }
    }
}
