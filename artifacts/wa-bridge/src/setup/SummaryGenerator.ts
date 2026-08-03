export class SummaryGenerator {
    static display(config: Record<string, any>) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━');
        console.log('      Setup Summary');
        console.log('━━━━━━━━━━━━━━━━━━━━━━\n');

        for (const [key, value] of Object.entries(config)) {
            let displayValue = value;
            if (typeof value === 'boolean') {
                displayValue = value ? '\x1b[32m✓ Enabled\x1b[0m' : '\x1b[31m✗ Disabled\x1b[0m';
            } else if (key.toLowerCase().includes('token') || key.toLowerCase().includes('password') || key.toLowerCase().includes('key')) {
                displayValue = '******** (Hidden)';
            }
            
            console.log(`${key.padEnd(20)}: ${displayValue}`);
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━');
    }
}
