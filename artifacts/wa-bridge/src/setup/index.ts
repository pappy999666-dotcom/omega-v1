import { QuestionManager } from './QuestionManager.js';
import { Validator } from './Validator.js';
import { Installer } from './Installer.js';
import { DependencyChecker } from './DependencyChecker.js';
import { ConfigWriter } from './ConfigWriter.js';
import { ConnectionTester } from './ConnectionTester.js';
import { SummaryGenerator } from './SummaryGenerator.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export async function runSetupWizard() {
    const qm = new QuestionManager();
    const config: any = {};
    const env: Record<string, string> = {};

    console.log('\n\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('      OMEGA-V1 • CYBERNETIC SETUP WIZARD');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n');

    // 1. Dependency Detection
    console.log('\x1b[36m[1/6] Scanning System Dependencies...\x1b[0m');
    const requiredDeps = ['node', 'npm', 'pnpm', 'git', 'ffmpeg', 'curl', 'zip', 'tar'];
    const optionalDeps = ['redis', 'mongodb', 'imagemagick', 'python', 'bun'];
    
    const allDeps = [...requiredDeps, ...optionalDeps];
    for (const dep of allDeps) {
        const isMissing = DependencyChecker.checkMissingDependencies([dep]).length > 0;
        if (isMissing) {
            if (requiredDeps.includes(dep)) {
                console.log(`\x1b[31m✖ ${dep} is missing (REQUIRED)\x1b[0m`);
                const choice = await qm.select(`How would you like to handle missing ${dep}?`, [
                    `Attempt to install ${dep} automatically`,
                    `I will install it manually (Exit setup)`,
                    `Continue anyway (Not recommended)`
                ]);
                
                if (choice === `Attempt to install ${dep} automatically`) {
                    const success = Installer.installSystemDependency(dep);
                    if (!success) {
                        console.log(`\x1b[31mFailed to install ${dep}. Please install it manually.\x1b[0m`);
                        if (await qm.confirm('Exit setup to fix dependencies?')) {
                            process.exit(1);
                        }
                    }
                } else if (choice === `I will install it manually (Exit setup)`) {
                    process.exit(1);
                }
            } else {
                console.log(`\x1b[33m⚠ ${dep} is missing (Optional)\x1b[0m`);
                const choice = await qm.select(`${dep} is recommended but not found.`, [
                    `Install ${dep} now`,
                    `Skip (I don't need this feature)`,
                    `Use remote service (for Redis/Mongo)`
                ]);
                if (choice === `Install ${dep} now`) {
                    Installer.installSystemDependency(dep);
                }
            }
        } else {
            console.log(`\x1b[32m✔ ${dep} is ready\x1b[0m`);
        }
    }

    // 2. Interactive Questions
    console.log('\n\x1b[36m[2/6] Identity & Access Configuration...\x1b[0m');
    
    // Telegram
    env.TELEGRAM_BOT_TOKEN = await qm.askWithValidation(
        'Telegram Bot Token (@BotFather)',
        Validator.isTelegramToken,
        'Invalid Token format. Expected 123456789:ABCDefghIJKLmnopQRSTuvwxYZ'
    );

    env.TELEGRAM_OWNER_ID = await qm.askWithValidation(
        'Owner Telegram ID (numeric)',
        Validator.isNumeric,
        'Owner ID must be numeric. Use @userinfobot to find it.'
    );

    env.TELEGRAM_OWNER_USERNAME = await qm.ask('Owner Username (without @)');
    env.TELEGRAM_ADMIN_IDS = await qm.ask('Admin IDs (comma separated, optional)', env.TELEGRAM_OWNER_ID);
    env.TELEGRAM_LOG_CHAT_ID = await qm.ask('Log Chat ID (optional, bot must be member)');

    // 3. Infrastructure
    console.log('\n\x1b[36m[3/6] Database & Infrastructure...\x1b[0m');
    
    // Database
    const dbType = await qm.select('Primary Database Type', ['MongoDB', 'SQLite', 'PostgreSQL', 'MySQL']);
    config.database = { type: dbType };
    
    if (dbType === 'MongoDB') {
        env.MONGO_URI = await qm.askWithValidation(
            'MongoDB URI',
            Validator.isMongoURI,
            'Invalid MongoDB URI format',
            'mongodb://localhost:27017/omega'
        );
    } else if (dbType === 'SQLite') {
        config.database.path = await qm.ask('SQLite path', './database.sqlite');
    } else {
        env.DB_HOST = await qm.ask('Host', 'localhost');
        env.DB_PORT = await qm.ask('Port', dbType === 'PostgreSQL' ? '5432' : '3306');
        env.DB_USER = await qm.ask('User');
        env.DB_PASS = await qm.ask('Password');
        env.DB_NAME = await qm.ask('Database Name', 'omega_bot');
    }

    // Redis
    config.useRedis = await qm.confirm('Enable Redis for high-performance queues?', true);
    if (config.useRedis) {
        env.REDIS_URL = await qm.askWithValidation(
            'Redis URL',
            Validator.isRedisURL,
            'Invalid Redis URL format',
            'redis://localhost:6379'
        );
    }

    // WhatsApp
    console.log('\n\x1b[36m[4/6] WhatsApp Engine...\x1b[0m');
    config.whatsapp = {
        pairingMode: await qm.select('Default Pairing Mode', ['QR', 'Pairing Code']),
        sessionFolder: await qm.ask('Session storage path', './sessions')
    };

    // 4. Web Dashboard
    console.log('\n\x1b[36m[5/6] Web Dashboard...\x1b[0m');
    config.enableWebDashboard = await qm.confirm('Enable Web Control Panel?', true);
    if (config.enableWebDashboard) {
        const port = await qm.askWithValidation(
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
            domain: await qm.ask('Domain / IP', 'localhost'),
            useHttps: await qm.confirm('Use HTTPS (Reverse Proxy recommended)?', false),
            auth: {
                username: await qm.ask('Admin Username', 'admin'),
                password: await qm.ask('Admin Password', crypto.randomBytes(4).toString('hex'))
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
        if (await qm.confirm(`Enable ${plugin} support?`, false)) {
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
        'Web Dashboard': config.enableWebDashboard ? `Port ${config.web.port}` : 'Disabled'
    };
    SummaryGenerator.display(summaryData);

    if (await qm.confirm('\nSave configuration and proceed to startup?')) {
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
