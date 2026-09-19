// Run with explicit environment configuration; do not auto-load a clinical .env.
const fs = require('node:fs/promises');
const { auditImageStorage } = require('../src/services/imageStorageAudit');

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') throw Error('Usage: node scripts/audit-image-storage.js --out /private/path/audit.manifest.json (read-only)');
  for (const name of ['DB_HOST','DB_NAME','MINIO_HOST','MINIO_BUCKET']) {
    if (!process.env[name]) throw Error(`Explicit ${name} is required`);
  }
  const { pool } = require('../src/config/database');
  try {
    const manifest = await auditImageStorage({ pool, storage:require('../src/services/storage'),
      identity:{database:process.env.DB_NAME,dbHost:process.env.DB_HOST,dbPort:process.env.DB_PORT || '5432',
        minioHost:process.env.MINIO_HOST,minioPort:process.env.MINIO_PORT || '9000',bucket:process.env.MINIO_BUCKET} });
    await fs.writeFile(args[1],JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({images:manifest.imageCount,overlays:manifest.overlayCount,
      legacyReferences:manifest.legacyReferenceCount,objects:manifest.objects.length,candidateBytes:manifest.candidateBytes}));
  } finally { await pool.end(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
