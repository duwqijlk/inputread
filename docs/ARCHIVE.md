# Where the old pull requests are

Recorded on 2026-10-04. The public project is now `duwqijlk/inputread`; the former public repository `duwqijlk/margin-words` is retired, private and no longer maintained. Later work happens in `inputread`.

The private archive is `duwqijlk/margin-words-archive`. The owner archived it on 2026-10-04. It is read-only. Pull requests #1 through #34 stay there. Do not unarchive it, and do not make it public. Develop, push, and open pull requests only in `duwqijlk/inputread`.

Pull requests #1 through #32 on that archive still point at commits that contain copyrighted EPUB files. GitHub does not let the owner delete `refs/pull/*/head`. This public repository was created as a new repository and received only the rewritten `main`. That history has no third-party EPUB. The only EPUB here is the project's own sample, `examples/sample-book/the-lantern-seller.epub`.

The private R2 bucket `margin-words-private` is storage for copyrighted EPUB files. It is not a Git repository.

The live site is not connected to GitHub. Cloudflare Pages project `margin-words` (Git source: none), the D1 database, and the R2 buckets stay where they are. https://inputread.site does not depend on GitHub.

中文说明：[ARCHIVE.zh-CN.md](ARCHIVE.zh-CN.md)
