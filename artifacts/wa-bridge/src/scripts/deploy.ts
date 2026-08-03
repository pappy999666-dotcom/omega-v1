import { runDeployment } from '../services/deployment.js';
import { logger } from '../utils/logger.js';

async function main() {
  console.log('\n🚀 Starting OMEGA-V1 Smart Update Pipeline...\n');

  const result = await runDeployment(async (log) => {
    // Clear console and print log for a clean experience
    console.clear();
    console.log('🚀 OMEGA-V1 Smart Update Pipeline\n');
    console.log(log.map(line => line.replace(/<[^>]*>/g, '')).join('\n'));
  });

  if (result.success) {
    console.log('\n✅ Update completed successfully!');
    process.exit(0);
  } else {
    console.log(`\n❌ Update failed at step: ${result.failedStep}`);
    console.log(`Error: ${result.error}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ Fatal deployment error:', err);
  process.exit(1);
});
