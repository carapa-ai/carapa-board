# Native importer source fixtures

`source/` contains sanitized native inputs retained for the conversation
importer migration. These files are input evidence, not canonical transcripts
or expected V1 output.

`native-run-v1.test.ts` parses every retained source and validates its output
against the compact `CarapaRunManifestV1` and `CarapaRunEventV1` contract
implemented by `carapa-run-v1.ts`. Do not add a second V1 envelope or restore
the retired metadata-heavy Board-side schema.
