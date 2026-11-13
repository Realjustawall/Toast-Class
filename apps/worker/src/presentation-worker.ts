import type { DatabasePool, DatabaseConnection } from '../../api/src/database.js';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { PresentationService } from '../../api/src/presentations.js';
import type { FileConfig } from '../../api/src/files.js';
import { ConversionError, type DocumentConverter, type ConvertedDocument } from './conversion.js';

export class PresentationWorker {
  readonly service: PresentationService;
  constructor(
    pool: DatabasePool,
    readonly files: FileConfig,
    readonly converter: DocumentConverter,
  ) {
    this.service = new PresentationService(pool, files);
  }
  async once() {
    const job = await this.service.claimNext();
    if (!job) return false;
    let input: Readable | undefined,
      output: ConvertedDocument | undefined,
      heartbeat: Promise<unknown> | undefined,
      lost = false;
    const pulse = setInterval(() => {
      if (!heartbeat)
        heartbeat = this.service
          .heartbeat(job)
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => {
            lost = true;
          })
          .finally(() => {
            heartbeat = undefined;
          });
    }, 30000);
    try {
      const source = (
        await this.service.pool.query(
          "SELECT * FROM files WHERE id=$1 AND organization_id=$2 AND status='ready' AND purpose='resource'",
          [job.source_file_id, job.organization_id],
        )
      ).rows[0];
      if (!source?.sha256) throw new ConversionError('invalid_input');
      input = await this.service.files.requireStorage().get(source.object_key);
      output = await this.converter.convert(input, {
        extension: extname(source.original_name).slice(1).toLowerCase(),
        byteSize: Number(source.byte_size),
        sha256: source.sha256,
      });
      if (lost) throw new ConversionError('worker_lease_expired');
      for (const asset of output.assets) {
        if (lost) throw new ConversionError('worker_lease_expired');
        await this.service.stageAsset(job, asset, (key) =>
          this.service.files
            .requireStorage()
            .put(
              key,
              asset.path,
              asset.byteSize,
              asset.page === 0 ? 'application/pdf' : 'image/png',
            ),
        );
      }
      await this.service.complete(job, output.pageCount);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'presentation_worker.job_failed',
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await this.service.failed(
        job,
        error instanceof ConversionError ? error.code : 'document_processing_failed',
      );
    } finally {
      clearInterval(pulse);
      await heartbeat;
      input?.destroy();
      await output?.dispose();
    }
    return true;
  }
}
