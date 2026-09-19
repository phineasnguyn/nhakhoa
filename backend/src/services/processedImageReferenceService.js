function createProcessedImageReferenceService(dependencies = {}) {
  const pool = dependencies.pool || require('../config/database').pool;
  const storage = dependencies.storage || require('./storage');

  async function storeProcessedImageReference(imageId, fileBuffer, ext) {
    const processedHash = storage.computeHash(fileBuffer);
    const objectName = `processed_by_hash/${processedHash}.${ext}`;
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query('BEGIN');
      transactionStarted = true;

      // Lock the image before uploading so patient deletion and processing cannot
      // mutate the same record concurrently.
      const imageResult = await client.query(
        'SELECT id FROM images WHERE id = $1 FOR UPDATE',
        [imageId]
      );
      if (imageResult.rows.length === 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return { success: false, skipped: true, error: 'Image no longer exists' };
      }

      // Storage garbage collection takes the same transaction-scoped lock before
      // checking references and deleting this content-addressed object.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [objectName]
      );

      const ensureResult = await storage.ensureUploadByHash(
        fileBuffer,
        'processed_by_hash',
        ext,
        'image/jpeg'
      );
      if (!ensureResult.success) {
        throw new Error(ensureResult.error || 'Unable to store processed image');
      }

      const bucketName = process.env.MINIO_BUCKET || 'nhakhoa';
      const urlProcessed = `/${bucketName}/${ensureResult.objectName}`;
      await client.query(
        `UPDATE images
         SET url_processed = $1,
             processing_status = 'completed',
             processed_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [urlProcessed, imageId]
      );

      await client.query('COMMIT');
      transactionStarted = false;
      return {
        success: true,
        urlProcessed,
        objectName: ensureResult.objectName,
        hash: ensureResult.hash,
      };
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch((rollbackError) => {
          console.error('Processed image reference rollback failed:', rollbackError);
        });
      }
      return { success: false, error: error.message };
    } finally {
      client.release();
    }
  }

  return { storeProcessedImageReference };
}

let defaultService;

const storeProcessedImageReference = (...args) => {
  if (!defaultService) defaultService = createProcessedImageReferenceService();
  return defaultService.storeProcessedImageReference(...args);
};

module.exports = {
  createProcessedImageReferenceService,
  storeProcessedImageReference,
};
