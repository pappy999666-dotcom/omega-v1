import { QuestionManager } from './QuestionManager.js';
import { Validator } from './Validator.js';
import { Installer } from './Installer.js';
import { DependencyChecker } from './DependencyChecker.js';
import { ConfigWriter } from './ConfigWriter.js';
import { ConnectionTester } from './ConnectionTester.js';
import { SummaryGenerator } from './SummaryGenerator.js';
import crypto from 'crypto';

export async function runSetupWizard() {
    const qm = new QuestionManager();
    const config: any = {};
    const env: Record<string, string> = {};

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' Welcome to Omega Setup Wizard');
    console.log(' Let\'s configure your bot.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━\n');

    // 1. Startup Detection
    console.log('Checking environment...');
    const systemDeps = ['git', 'ffmpeg', 'node', 'curl'];
    const missingDeps = DependencyChecker.checkMissingDependencies(systemDeps);
    if (missingDeps.length > 0) {
        console.log(`Missing dependencies: ${missingDeps.join(', ')}`);
        for (const dep of missingDeps) {
            const confirm = await qm.confirm(`Would you like to install ${dep}?`);
            if (confirm) {
                Installer.installSystemDependency(dep);
            }
        }
    }

    // 2. Interactive Questions
    
    // Telegram
    console.log('\n--- Telegram Configuration ---');
    env.TELEGRAM_BOT_TOKEN = await qm.askWithValidation(
        'Paste your Telegram Bot Token',
        Validator.isTelegramToken,
        'Invalid Telegram Bot Token format. Expected 123456789:ABCDefghIJKLmnopQRSTuvwxYZ'
    );

    env.TELEGRAM_OWNER_ID = await qm.askWithValidation(
        'Owner ID',
        Validator.isNumeric,
        'Owner ID must be numeric'
    );

    env.TELEGRAM_ADMIN_IDS = await qm.ask('Admin IDs (comma separated)', env.TELEGRAM_OWNER_ID);
    env.TELEGRAM_LOG_CHAT_ID = await qm.ask('Log Chat ID (optional)');

    // WhatsApp
    console.log('\n--- WhatsApp Configuration ---');
    config.whatsapp = {
        pairingMode: await qm.select('Which pairing mode would you like?', ['QR', 'Pairing Code']),
        sessionFolder: await qm.ask('Session folder', './sessions')
    };

    // Database
    console.log('\n--- Database Configuration ---');
    const dbType = await qm.select('Which database would you like?', ['MongoDB', 'SQLite', 'PostgreSQL', 'MySQL']);
    config.database = { type: dbType };
    
    if (dbType === 'MongoDB') {
        env.MONGO_URI = await qm.ask('MongoDB URI', 'mongodb://localhost:27017/bot');
    } else if (dbType === 'SQLite') {
        config.database.path = await qm.ask('SQLite database path', './database.sqlite');
    } else {
        env.DB_HOST = await qm.ask('Database Host', 'localhost');
        env.DB_PORT = await qm.ask('Database Port', dbType === 'PostgreSQL' ? '5432' : '3306');
        env.DB_USER = await qm.ask('Database User');
        env.DB_PASS = await qm.ask('Database Password');
        env.DB_NAME = await qm.ask('Database Name', 'omega_bot');
    }

    // Redis
    console.log('\n--- Redis Configuration ---');
    config.useRedis = await qm.confirm('Would you like to enable Redis?');
    if (config.useRedis) {
        const hasRedis = DependencyChecker.checkRedis();
        if (!hasRedis) {
            const installRedis = await qm.confirm('Redis is not installed. Would you like to install it?');
            if (installRedis) {
                Installer.installSystemDependency('redis-server');
            }
        }
        env.REDIS_URL = await qm.ask('Redis URL', 'redis://localhost:6379');
    }

    // Storage
    console.log('\n--- Storage ---');
    config.storage = await qm.select('Choose storage backend', ['Local', 'S3', 'Cloudinary']);

    // Web Panel
    console.log('\n--- Web Dashboard ---');
    config.enableWebDashboard = await qm.confirm('Enable Web Dashboard?');
    if (config.enableWebDashboard) {
        config.web = {
            port: await qm.askWithValidation('Port', Validator.isPortAvailable, 'Port is already in use or invalid', '3000'),
            domain: await qm.ask('Domain', 'localhost'),
            useHttps: await qm.confirm('Use HTTPS?'),
            auth: {
                username: await qm.ask('Dashboard Username', 'admin'),
                password: await qm.ask('Dashboard Password', 'password')
            }
        };
        env.WEB_PORT = config.web.port;
        env.WEB_DOMAIN = config.web.domain;
        env.WEB_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

        if (config.web.useHttps) {
            config.web.ssl = {
                type: await qm.select('SSL Configuration', ['Self-signed', 'Cloudflare', 'DuckDNS', 'Manual']),
                email: await qm.ask('SSL Notification Email')
            };
        }
    }

    // General
    console.log('\n--- General ---');
    config.language = await qm.ask('Language', 'en');
    config.timezone = await qm.ask('Timezone', 'UTC');
    config.detailedLogs = await qm.confirm('Enable detailed logs?');

    // 3. Plugin Detection
    console.log('\n--- Plugin Configuration ---');
    const plugins = ['Pinterest', 'OpenAI', 'Gemini', 'Claude', 'OCR', 'Translate', 'Weather'];
    config.plugins = {};
    for (const plugin of plugins) {
        const enable = await qm.confirm(`Enable ${plugin} plugin?`, false);
        if (enable) {
            config.plugins[plugin.toLowerCase()] = {
                apiKey: await qm.ask(`${plugin} API Key`)
            };
            env[`${plugin.toUpperCase()}_API_KEY`] = config.plugins[plugin.toLowerCase()].apiKey;
        }
    }

    // 4. Summary
    const summaryData = {
        'Bot Token': ConfigWriter.maskSecret(env.TELEGRAM_BOT_TOKEN),
        'Database': config.database.type,
        'Redis': config.useRedis,
        'Web Dashboard': config.enableWebDashboard,
        'Language': config.language,
        'Timezone': config.timezone
    };
    SummaryGenerator.display(summaryData);

    const save = await qm.confirm('Save configuration?');
    if (save) {
        console.log('\nSaving configuration...');
        ConfigWriter.writeEnv(env);
        ConfigWriter.writeConfigJson(config);
        
        // Ensure directories
        const dirs = ['logs', 'uploads', 'sessions', 'temp', 'cache'];
        dirs.forEach(dir => ConfigWriter.ensureDirectory(dir));

        console.log('\nTesting services...');
        
        // Redis check
        if (config.useRedis) {
            const redisOk = await ConnectionTester.testRedis();
            console.log(`Redis: ${redisOk ? '\x1b[32mConnected\x1b[0m' : '\x1b[31mFailed\x1b[0m'}`);
        }

        // Telegram check
        const telegramOk = await ConnectionTester.testTelegram(env.TELEGRAM_BOT_TOKEN);
        console.log(`Telegram: ${telegramOk ? '\x1b[32mConnected\x1b[0m' : '\x1b[31mInvalid Token\x1b[0m'}`);

        console.log('\n\x1b[32mSetup complete! You can now start the bot.\x1b[0m');
    } else {
        console.log('\nSetup cancelled.');
    }

    qm.close();
}
