Place a production MongoDB server binary tree here when you want the installer to ship with MongoDB.

Expected packaged path:

- vendor/mongodb/bin/mongod

At runtime the desktop app resolves MongoDB in this order:

1. RMS_MONGOD_PATH
2. packaged resources/mongodb/bin/mongod
3. local desktop/vendor/mongodb/bin/mongod during development
4. system mongod on PATH

Keep only the files needed by the target platform in this directory before packaging.
