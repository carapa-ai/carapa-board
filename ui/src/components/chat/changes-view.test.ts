// @ts-nocheck
import { describe, expect, test } from 'bun:test';

import { splitPatch } from './changes-view';

describe('splitPatch change types', () => {
  test('classifies each patch section from its Git metadata', () => {
    const files = splitPatch(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+export {};
diff --git a/modified.ts b/modified.ts
--- a/modified.ts
+++ b/modified.ts
@@ -1 +1 @@
-old
+new
diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
--- a/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-deleted
diff --git a/old-name.ts b/new-name.ts
similarity index 80%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1 +1 @@
-old
+new`);

    expect(files.map(({ name, changeType }) => ({ name, changeType }))).toEqual([
      { name: 'new.ts', changeType: 'new' },
      { name: 'modified.ts', changeType: 'modified' },
      { name: 'deleted.ts', changeType: 'deleted' },
      { name: 'new-name.ts', changeType: 'renamed' },
    ]);
  });
});
