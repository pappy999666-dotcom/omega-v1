import { QuestionManager } from './QuestionManager.js';
import { Validator } from './Validator.js';

import { ConfigWriter } from './ConfigWriter.js';
import { ConnectionTester } from './ConnectionTester.js';
import { SummaryGenerator } from './SummaryGenerator.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { stdin as input, stdout as output } from 'process';

export async function runSetupWizard() {
    const qm = new QuestionManager();
    const config: any = {};
    const env: Record<string, string> = {};
    
    let mongodbInstalledLocally = false;
    let redisInstalledLocally = false;

    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('      OMEGA-V1 • CYBERNETIC SETUP WIZARD');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

    const isQuick = (!input.isTTY || !output.isTTY);
    const setupMode = isQuick ? 'Quick Setup (Zero-Config, uses smart defaults)' : await qm.select('Choose Setup Mode', [
        'Quick Setup (Zero-Config, uses smart defaults)',
        'Advanced Setup (Custom configuration)'
    ]);

    // 1. Dependency Detection is now handled by the main setup script.
    console.log('\n\x1b[36m[1/6] System Dependencies assumed ready by main setup script.\x1b[0m');
    // Set these to true as the main setup script ensures they are installed
    mongodbInstalledLocally = true;
    redisInstalledLocally = true;

    // 2. Interactive Questions
    console.log('\n\x1b[36m[2/6] Identity & Access Configuration...\x1b[0m');
    
    // Telegram
    env.TELEGRAM_BOT_TOKEN = isQuick && process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN : await qm.askWithValidation(
        'Telegram Bot Token (@BotFather)',
        Validator.isTelegramToken,
        'Invalid Token format. Expected 123456789:ABCDefghIJKLmnopQRSTuvwxYZ'
    );

    env.TELEGRAM_OWNER_ID = isQuick && process.env.TELEGRAM_OWNER_ID ? process.env.TELEGRAM_OWNER_ID : await qm.askWithValidation(
        'Owner Telegram ID (numeric)',
        Validator.isNumeric,
        'Owner ID must be numeric. Use @userinfobot to find it.'
    );

    env.TELEGRAM_OWNER_USERNAME = isQuick ? 'admin' : await qm.ask('Owner Username (without @)');
    env.TELEGRAM_ADMIN_IDS = isQuick ? env.TELEGRAM_OWNER_ID : await qm.ask('Admin IDs (comma separated, optional)', env.TELEGRAM_OWNER_ID);
    env.TELEGRAM_LOG_CHAT_ID = isQuick ? '' : await qm.ask('Log Chat ID (optional, bot must be member)');

    // 3. Infrastructure
    console.log('\n\x1b[36m[3/6] Database & Infrastructure...\x1b[0m');
    
    // Database
    const dbType = isQuick ? (mongodbInstalledLocally ? 'MongoDB' : 'SQLite') : await qm.select('Primary Database Type', ['MongoDB', 'SQLite', 'PostgreSQL', 'MySQL']);
    config.database = { type: dbType };
    
    if (dbType === 'MongoDB') {
        if (isQuick && mongodbInstalledLocally) {
            env.MONGO_URI = 'mongodb://localhost:27017/omega';
            console.log(`\x1b[32m✔ MongoDB auto-configured to local instance\x1b[0m`);
        } else {
            env.MONGO_URI = await qm.askWithValidation(
                'MongoDB URI',
                Validator.isMongoURI,
                'Invalid MongoDB URI format',
                'mongodb://localhost:27017/omega'
            );
        }
    } else if (dbType === 'SQLite') {
        config.database.path = isQuick ? './database.sqlite' : await qm.ask('SQLite path', './database.sqlite');
    } else {
        env.DB_HOST = await qm.ask('Host', 'localhost');
        env.DB_PORT = await qm.ask('Port', dbType === 'PostgreSQL' ? '5432' : '3306');
        env.DB_USER = await qm.ask('User');
        env.DB_PASS = await qm.ask('Password');
        env.DB_NAME = await qm.ask('Database Name', 'omega_bot');
    }

    // Redis
    config.useRedis = isQuick ? redisInstalledLocally : await qm.confirm('Enable Redis for high-performance queues?', true);
    if (config.useRedis) {
        if (isQuick && redisInstalledLocally) {
            env.REDIS_URL = 'redis://localhost:6379';
            console.log(`\x1b[32m✔ Redis auto-configured to local instance\x1b[0m`);
        } else {
            env.REDIS_URL = await qm.askWithValidation(
                'Redis URL',
                Validator.isRedisURL,
                'Invalid Redis URL format',
                'redis://localhost:6379'
            );
        }
    }

    // WhatsApp
    console.log('\n\x1b[36m[4/6] WhatsApp Engine...\x1b[0m');
    config.whatsapp = {
        pairingMode: isQuick ? 'QR' : await qm.select('Default Pairing Mode', ['QR', 'Pairing Code']),
        sessionFolder: isQuick ? './sessions' : await qm.ask('Session storage path', './sessions')
    };

    // 4. Web Dashboard
    console.log('\n\x1b[36m[5/6] Web Dashboard...\x1b[0m');
    config.enableWebDashboard = isQuick ? true : await qm.confirm('Enable Web Control Panel?', true);
    if (config.enableWebDashboard) {
        const port = isQuick ? '3000' : await qm.askWithValidation(
            'Dashboard Port',
            async (p) => {
                const res = await Validator.isPortAvailable(p);
                return res === true;
            },
            'Port is unavailable or invalid',
            '3000'
        );
        
        config.web = {
            port: port,
            domain: isQuick ? 'localhost' : await qm.ask('Domain / IP', 'localhost'),
            useHttps: isQuick ? false : await qm.confirm('Use HTTPS (Reverse Proxy recommended)?', false),
            auth: {
                username: isQuick ? 'admin' : await qm.ask('Admin Username', 'admin'),
                password: isQuick ? crypto.randomBytes(4).toString('hex') : await qm.ask('Admin Password', crypto.randomBytes(4).toString('hex'))
            }
        };
        env.WEB_PORT = config.web.port;
        env.WEB_DOMAIN = config.web.domain;
        env.WEB_SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    }

    // 5. Plugins
    console.log('\n\x1b[36m[6/6] AI & Plugins...\x1b[0m');
    const plugins = ['OpenAI', 'Gemini', 'Claude', 'Pinterest', 'Weather'];
    config.plugins = {};
    for (const plugin of plugins) {
        const shouldEnable = isQuick ? false : await qm.confirm(`Enable ${plugin} support?`, false);
        if (shouldEnable) {
            const key = await qm.ask(`${plugin} API Key`);
            config.plugins[plugin.toLowerCase()] = { apiKey: key };
            env[`${plugin.toUpperCase()}_API_KEY`] = key;
        }
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
        'Web Dashboard': config.enableWebDashboard ? `Port ${config.web.port}` : 'Disabled',
        'Setup Mode': isQuick ? 'Quick (Zero-Config)' : 'Advanced'
    };
    SummaryGenerator.display(summaryData);

    if (isQuick || await qm.confirm('\nSave configuration and proceed to startup?')) {
        console.log('\nWriting files...');
        ConfigWriter.writeEnv(env);
        ConfigWriter.writeConfigJson(config);
        
        // Ensure directories
        ['logs', 'uploads', 'sessions', 'temp', 'cache'].forEach(dir => ConfigWriter.ensureDirectory(dir));

        console.log('\nRunning health checks...');
        
        // Connectivity checks
        if (config.useRedis) {
            const redisOk = await ConnectionTester.testRedis(env.REDIS_URL);
            console.log(`Redis: ${redisOk ? '\x1b[32mConnected ✓\x1b[0m' : '\x1b[31mConnection Failed ✖\x1b[0m'}`);
        }

        if (dbType === 'MongoDB') {
            const mongoOk = await ConnectionTester.testMongo(env.MONGO_URI);
            console.log(`MongoDB: ${mongoOk ? '\x1b[32mConnected ✓\x1b[0m' : '\x1b[31mConnection Failed ✖\x1b[0m'}`);
        }

        const telegramOk = await ConnectionTester.testTelegram(env.TELEGRAM_BOT_TOKEN);
        console.log(`Telegram API: ${telegramOk ? '\x1b[32mConnected ✓\x1b[0m' : '\x1b[31mInvalid Token ✖\x1b[0m'}`);

        console.log('\n\x1b[32m✅ Setup complete!\x1b[0m');
    } else {
        console.log('\n\x1b[33mSetup cancelled. Configuration NOT saved.\x1b[0m');
        process.exit(0);
    }

    qm.close();
}
