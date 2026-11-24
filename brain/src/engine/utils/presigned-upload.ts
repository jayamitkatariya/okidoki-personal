import type { Readable } from 'stream';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

export async function putPresignedFile(
  urlValue: string,
  body: Readable,
  size: number,
  contentType: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const url = new URL(urlValue);
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'PUT',
      headers: {
        'content-length': String(size),
        'content-type': contentType,
      },
    }, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`upload failed: ${status} ${body}`));
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    body.on('error', (error) => request.destroy(error));
    body.pipe(request);
  });
}
