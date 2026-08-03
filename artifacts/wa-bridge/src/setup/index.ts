import { QuestionManager } from './QuestionManager.js';
import { Validator } from './Validator.js';
import { ConfigWriter } from './ConfigWriter.js';
import { ConnectionTester } from './ConnectionTester.js';
import { SummaryGenerator } from './SummaryGenerator.js';
import { DependencyChecker } from './DependencyChecker.js';
import { Installer } from './Installer.js';
import { DeploymentManager } from './DeploymentManager.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { stdin as input, stdout as output } from 'process';
import { execSync } from 'child_process';

export async function runSetupWizard() {
    const qm = new QuestionManager();
    const config: any = {};
    const env: Record<string, string> = {};
    
    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('      OMEGA-V1 • ZERO-CONFIG SETUP WIZARD');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

    const isQuick = (!input.isTTY || !output.isTTY);
    
    // 1. Automatic System Detection & Dependency Installation
    console.log('\n\x1b[36m[1/6] Automatic System Detection...\x1b[0m');
    
    const workspaceInfo = DependencyChecker.detectWorkspaceInfo();
    console.log(`✓ Workspace Root: ${workspaceInfo.root}`);
    
    const requiredDeps = ['git', 'curl', 'ffmpeg', 'imagemagick', 'redis', 'mongodb', 'nginx', 'pm2'];
    const missingDeps = DependencyChecker.getMissingDependencies(requiredDeps);
    
    if (missingDeps.length > 0) {
        console.log(`\x1b[33mFound ${missingDeps.length} missing dependencies: ${missingDeps.join(', ')}\x1b[0m`);
        for (const dep of missingDeps) {
            const success = Installer.installSystemDependency(dep);
            if (!success) {
                console.log(`\x1b[31mCRITICAL: Failed to install ${dep}. Please install it manually.\x1b[0m`);
            }
        }
    } else {
        console.log('✓ All system dependencies are already installed.');
    }

    // Verify services are running
    Installer.configureService('redis');
    Installer.configureService('mongodb');
    Installer.configureService('nginx');

    // 2. Identity & Access (The only required inputs)
    console.log('\n\x1b[36m[2/6] Identity & Access Configuration...\x1b[0m');
    
    env.TELEGRAM_BOT_TOKEN = await qm.askWithValidation(
        'Telegram Bot Token (@BotFather)',
        Validator.isTelegramToken,
        'Invalid Token format. Expected 123456789:ABCDefghIJKLmnopQRSTuvwxYZ',
        process.env.TELEGRAM_BOT_TOKEN || ''
    );

    env.TELEGRAM_OWNER_ID = await qm.askWithValidation(
        'Owner Telegram ID (numeric)',
        Validator.isNumeric,
        'Owner ID must be numeric. Use @userinfobot to find it.',
        process.env.TELEGRAM_OWNER_ID || ''
    );

    env.TELEGRAM_OWNER_USERNAME = await qm.ask('Owner Username (without @)', 'admin');
    env.TELEGRAM_ADMIN_IDS = env.TELEGRAM_OWNER_ID;
    env.TELEGRAM_LOG_CHAT_ID = '';

    // 3. Infrastructure (Auto-detected)
    console.log('\n\x1b[36m[3/6] Infrastructure (Auto-Detected)...\x1b[0m');
    
    const hasMongo = DependencyChecker.checkMongo();
    const hasRedis = DependencyChecker.checkRedis();

    config.database = { type: hasMongo ? 'MongoDB' : 'SQLite' };
    if (hasMongo) {
        env.MONGO_URI = 'mongodb://localhost:27017/omega';
        console.log('✓ MongoDB: Detected & Configured (localhost)');
    } else {
        config.database.path = './database.sqlite';
        console.log('✓ MongoDB: Not found, using SQLite fallback');
    }

    config.useRedis = hasRedis;
    if (hasRedis) {
        env.REDIS_URL = 'redis://localhost:6379';
        console.log('✓ Redis: Detected & Configured (localhost)');
    } else {
        console.log('✓ Redis: Not found, proceeding without cache');
    }

    // 4. WhatsApp Engine
    config.whatsapp = {
        pairingMode: 'QR',
        sessionFolder: './sessions'
    };

    // 5. Web Dashboard & Nginx
    console.log('\n\x1b[36m[4/6] Web Dashboard & Nginx...\x1b[0m');
    
    config.enableWebDashboard = await qm.confirm('Enable Web Control Panel?', true);
    if (config.enableWebDashboard) {
        config.web = {
            port: '3000',
            domain: await qm.ask('Domain Name (e.g. omega.example.com)', 'localhost'),
            useHttps: false, // Will be handled by smart deployment if domain is not localhost
            auth: {
                username: 'admin',
                password: crypto.randomBytes(4).toString('hex')
            }
        };
        
        if (config.web.domain !== 'localhost') {
            config.web.useHttps = await qm.confirm(`Enable HTTPS for ${config.web.domain}?`, true);
            if (config.web.useHttps) {
                config.web.httpsEmail = await qm.ask('Email for Let\'s Encrypt certificates');
            }
        }

        env.WEB_PORT = config.web.port;
        env.WEB_DOMAIN = config.web.domain;
        env.WEB_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    }

    // 6. Finalization
    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('             CONFIGURATION SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    
    const summaryData = {
        'Bot Token': ConfigWriter.maskSecret(env.TELEGRAM_BOT_TOKEN),
        'Owner ID': env.TELEGRAM_OWNER_ID,
        'Database': config.database.type,
        'Redis': config.useRedis ? 'Enabled' : 'Disabled',
        'Web Dashboard': config.enableWebDashboard ? `${config.web.domain}:${config.web.port}` : 'Disabled',
        'HTTPS': config.web?.useHttps ? 'Enabled' : 'Disabled'
    };
    SummaryGenerator.display(summaryData);

    console.log('\nWriting configuration files...');
    ConfigWriter.writeEnv(env);
    ConfigWriter.writeConfigJson(config);
    
    // Ensure directories
    ['logs', 'uploads', 'sessions', 'temp', 'cache'].forEach(dir => ConfigWriter.ensureDirectory(dir));

    console.log('\nRunning final health checks...');
    
    if (config.useRedis) {
        const redisOk = await ConnectionTester.testRedis(env.REDIS_URL);
        console.log(`Redis: ${redisOk ? '\x1b[32mConnected ✓\x1b[0m' : '\x1b[31mConnection Failed ✖\x1b[0m'}`);
    }

    if (config.database.type === 'MongoDB') {
        const mongoOk = await ConnectionTester.testMongo(env.MONGO_URI);
        console.log(`MongoDB: ${mongoOk ? '\x1b[32mConnected ✓\x1b[0m' : '\x1b[31mConnection Failed ✖\x1b[0m'}`);
    }

    const telegramOk = await ConnectionTester.testTelegram(env.TELEGRAM_BOT_TOKEN);
    console.log(`Telegram API: ${telegramOk ? '\x1b[32mConnected ✓\x1b[0m' : '\x1b[31mInvalid Token ✖\x1b[0m'}`);

    // 7. Auto-Deployment
    console.log('\n\x1b[36m[6/6] Production Deployment...\x1b[0m');
    
    if (await qm.confirm('Launch bot under PM2 now?', true)) {
        // Detect entry point
        const distPath = path.join(workspaceInfo.botPackagePath, 'dist/index.js');
        
        if (!fs.existsSync(distPath)) {
            console.log('\n\x1b[33mBuild output not found. Running build...\x1b[0m');
            try {
                execSync('pnpm run build', { cwd: workspaceInfo.botPackagePath, stdio: 'inherit' });
            } catch (e) {
                console.log('\x1b[31mBuild failed. Please check the errors above.\x1b[0m');
            }
        }

        await DeploymentManager.configurePM2('wa-bridge', distPath);
        
        if (config.enableWebDashboard && config.web.domain !== 'localhost') {
            await DeploymentManager.configureNginx(config.web.domain, config.web.port, config.web.httpsEmail);
        }
    }

    console.log('\n\x1b[32m✅ Setup & Deployment complete!\x1b[0m');
    console.log('The bot is now running in the background.');
    console.log('Use "pm2 logs wa-bridge" to monitor the logs.');

    qm.close();
}
