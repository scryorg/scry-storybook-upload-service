export const METADATA_ZIP_FILE = 'metadata-screenshots.zip';

/** The one key a build's metadata ZIP lives at, for the old route and for presign / complete alike. */
export function metadataZipKeyFor(project: string, version: string, buildNumber: number): string {
  return `${project}/${version}/builds/${buildNumber}/${METADATA_ZIP_FILE}`;
}
