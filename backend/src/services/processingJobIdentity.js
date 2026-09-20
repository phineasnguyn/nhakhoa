// BullMQ reserves numeric custom IDs for its own sequence.
const processingQueueId = id => `image-${id}`;
function processingDatabaseId(job) {
  const id = /^image-(\d+)$/.exec(String(job.id))?.[1] ?? job.id;
  if (!/^\d+$/.test(String(id))) throw new Error('Missing database processing job id');
  return String(id);
}
module.exports = { processingQueueId, processingDatabaseId };
