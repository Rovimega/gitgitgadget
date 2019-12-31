import "jest";
import { CIHelper } from "../lib/ci-helper";
import { gitConfig } from "../lib/git";
import { GitNotes } from "../lib/git-notes";
import { GitHubGlue, IGitHubUser, IPullRequestInfo,
    IPRComment } from "../lib/github-glue";
import { IMailMetadata } from "../lib/mail-metadata";
import { testCreateRepo, TestRepo } from "./test-lib";

jest.setTimeout(60000);

// smtp testing support.  NodeMailer suggests using ethereal.email.
// The config must be set for the submit/preview tests to work.  They
// are skipped if the config is not set.
//
// Sample config settings:
//[gitgitgadget]
//	CIsmtpUser = first.last@ethereal.email
//	CIsmtphost = smtp.ethereal.email
//	CIsmtppass = feedeadbeeffeeddeadbeef
//	CIsmtpopts = { \"port\": 587, \"secure\": false, \"tls\": { \"rejectUnauthorized\": false } }
// The CIsmtpOpts must have the keys quoted.

async function getSMTPInfo():
    Promise <{ smtpUser: string, smtpHost: string,
               smtpPass: string, smtpOpts: string }> {
    const smtpUser = await gitConfig("gitgitgadget.CIsmtpUser") || "";
    const smtpHost = await gitConfig("gitgitgadget.CIsmtpHost") || "";
    const smtpPass = await gitConfig("gitgitgadget.CIsmtpPass") || "";
    const smtpOpts = await gitConfig("gitgitgadget.CIsmtpOpts") || "";
    return { smtpUser, smtpHost, smtpPass, smtpOpts };
}

// Mocking class to replace GithubGlue with mock of GitHubGlue

class TestCIHelper extends CIHelper {
    public ghGlue: GitHubGlue;      // not readonly reference
    public addPRComment: any;

    public constructor(workDir?: string, debug = false, gggDir = ".") {
        super(workDir, debug, gggDir);
        this.testing = true;
        this.ghGlue = this.github;
        this.addPRComment = jest.fn();
        this.ghGlue.addPRComment = this.addPRComment;
        // need keys to authenticate
        // this.ghGlue.ensureAuthenticated = async (): Promise<void> => {};
    }

    public setGHgetPRInfo(o: IPullRequestInfo) {
        this.ghGlue.getPRInfo = jest.fn( async ():
            Promise<IPullRequestInfo> => o );
    }

    public setGHgetPRComment(o: IPRComment) {
        this.ghGlue.getPRComment = jest.fn( async ():
            Promise<IPRComment> => o );
    }

    public setGHgetGitHubUserInfo(o: IGitHubUser) {
        this.ghGlue.getGitHubUserInfo = jest.fn( async ():
            Promise<IGitHubUser> => o );
    }
}

// Create three repos.
// worktree is a local copy for doing updates and has the config
// info that would normally be in the gitgitgadget repo.  To ensure
// testing isolation, worktree is NOT the repo used for git clone
// tests.  That work is done in gggLocal.

// gggRemote represents the master on github.

// gggLocal represents the empty repo to be used by gitgitgadget.  It
// is empty to ensure nothing needs to be present (worktree would
// have objects present).

async function setupRepos(instance: string):
    Promise <{ worktree: TestRepo, gggLocal: TestRepo, gggRemote: TestRepo }> {
    const worktree = await testCreateRepo(__filename, `-work-cmt${instance}`);
    const gggLocal = await testCreateRepo(__filename, `-git-lcl${instance}`);
    const gggRemote = await testCreateRepo(__filename, `-git-rmt${instance}`);

    // re-route the URLs
    await worktree.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    await gggLocal.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    // set needed config
    await worktree.git(["config",
        '--add', "gitgitgadget.workDir", gggLocal.workDir]);
    await worktree.git(["config",
        '--add', "gitgitgadget.publishRemote",
        "https://github.com/gitgitgadget/git"]);

    const { smtpUser, smtpHost, smtpPass, smtpOpts } =
        await getSMTPInfo();

    await worktree.git(["config",
        '--add', "gitgitgadget.smtpUser", smtpUser ? smtpUser : "test"]);

    await worktree.git(["config",
        '--add', "gitgitgadget.smtpHost", smtpHost ? smtpHost : "test"]);

    await worktree.git(["config",
        '--add', "gitgitgadget.smtpPass", smtpPass ? smtpPass : "test"]);

    if (smtpOpts) {
        await worktree.git(["config",
            '--add', "gitgitgadget.smtpOpts", smtpOpts]);
    }

    const notes = new GitNotes(gggRemote.workDir);
    await notes.set("", {allowedUsers: ["ggg", "user1"]}, true);

    // Initial empty commit
    const A = await gggRemote.commit("A");
    expect(A).not.toBeUndefined();

    // Set up fake upstream branches
    await gggRemote.git(["branch", "maint"]);
    await gggRemote.git(["branch", "next"]);
    await gggRemote.git(["branch", "pu"]);

    return { worktree, gggLocal, gggRemote };
}

test("identify merge that integrated some commit", async () => {
    const repo = await testCreateRepo(__filename);

    /*
     * Create a branch structure like this:
     *
     * a - b ----- c - d
     *   \       /   /
     *   | e ----- f
     *   \       /
     *     g - h
     */
    const a = await repo.commit("a");
    const g = await repo.commit("g");
    const h = await repo.commit("h");
    await repo.git(["reset", "--hard", a]);
    const e = await repo.commit("e");
    const f = await repo.merge("f", h);
    await repo.git(["reset", "--hard", a]);
    const b = await repo.commit("b");
    const c = await repo.merge("c", e);
    const d = await repo.merge("d", f);
    await repo.git(["update-ref", "refs/remotes/upstream/pu", d]);

    const ci = new CIHelper(repo.workDir);
    expect(b).not.toBeUndefined();
    expect(await ci.identifyMergeCommit("pu", g)).toEqual(d);
    expect(await ci.identifyMergeCommit("pu", e)).toEqual(c);
    expect(await ci.identifyMergeCommit("pu", h)).toEqual(d);
});

test("identify upstream commit", async () => {
    // initialize test worktree and gitgitgadget remote
    const worktree = await testCreateRepo(__filename, "-worktree");
    const gggRemote = await testCreateRepo(__filename, "-gitgitgadget");

    // re-route the URLs
    await worktree.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    // Set up fake upstream branches
    const A = await gggRemote.commit("A");
    expect(A).not.toBeUndefined();
    await gggRemote.git(["branch", "maint"]);
    await gggRemote.git(["branch", "next"]);
    await gggRemote.git(["branch", "pu"]);

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const b = await worktree.commit("b");

    // "Contribute" it via a PullRequest
    const pullRequestURL = "https://example.com/pull/123";
    const messageID = "fake-1st-mail@example.com";
    const notes = new GitNotes(worktree.workDir);
    await notes.appendCommitNote(b, messageID);
    const bMeta = {
        messageID,
        originalCommit: b,
        pullRequestURL,
    } as IMailMetadata;
    await notes.set(messageID, bMeta);

    // "Apply" the patch, and merge it
    await gggRemote.newBranch("gg/via-pull-request");
    const B = await gggRemote.commit("B");
    await gggRemote.git(["checkout", "pu"]);
    await gggRemote.git(["merge", "--no-ff", "gg/via-pull-request"]);

    // Update the `mail-to-commit` notes ref, at least the part we care about
    const mail2CommitNotes = new GitNotes(gggRemote.workDir,
                                          "refs/notes/mail-to-commit");
    await mail2CommitNotes.setString(messageID, B);

    // "publish" the gitgitgadget notes
    await worktree.git(["push", gggRemote.workDir, notes.notesRef]);

    class TestCIHelper extends CIHelper {
        public constructor() {
            super(worktree.workDir);
            this.testing = true;
        }
    }
    const ci = new TestCIHelper();
    expect(await ci.identifyUpstreamCommit(b)).toEqual(B);

    expect(await ci.updateCommitMapping(messageID)).toBeTruthy();
    const bMetaNew = await notes.get<IMailMetadata>(messageID);
    expect(bMetaNew).not.toBeUndefined();
    expect(bMetaNew!.originalCommit).toEqual(b);
    expect(bMetaNew!.commitInGitGit).toEqual(B);
});

test("handle comment allow basic test", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("a1");

    // Ready to start testing
    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",              // set in setupRepos
        body: "/allow  user2",
        prNumber: prNumber,
    };
    const user = {
        email: "user2@example.com",
        login: "user2",
        name: "User Two",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is now allowed to use GitGitGadget/);
});

test("handle comment allow fail invalid user", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("a2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const comment = {
        author: "ggg",
        body: "/allow  bad_@@@@",
        prNumber: prNumber,
    };

    ci.setGHgetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is not a valid GitHub username/);
});

test("handle comment allow no public email", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("a3");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const comment = {
        author: "ggg",
        body: "/allow   bad",
        prNumber: prNumber,
    };
    const user: IGitHubUser = {
        email: null,
        login: "noemail",
        name: "no email",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is now allowed to use GitGitGadget/);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/no public email address set/);
});

test("handle comment allow already allowed", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("a4");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/allow  ggg",
        prNumber: prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "not so bad",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/already allowed to use GitGitGadget/);
});

test("handle comment allow no name specified (with trailing white space)", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("a5");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/allow   ",
        prNumber: prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "not so bad",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/already allowed to use GitGitGadget/);
});

test("handle comment disallow basic test", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("d1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/disallow  user1 ",
        prNumber: prNumber,
    };
    const user = {
        email: "user1@example.com",
        login: "user1",
        name: "not so bad",
        type: "basic",
    };

    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/is no longer allowed to use GitGitGadget/);
});

test("handle comment disallow was not allowed", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("d2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/disallow  unknown1 ",
        prNumber: prNumber,
    };

    ci.setGHgetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/already not allowed to use GitGitGadget/);
});

test("handle comment submit not author", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("s1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber: prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "ee cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggNOTg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Only the owner of a PR can submit/);
});

test("handle comment submit not mergable", async () => {
    let { worktree,
          gggLocal,
    } = await setupRepos("s2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber: prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "ee cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: false,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Do Not Submit a fun fix",
    };

    ci.setGHgetPRInfo(prinfo);
    ci.setGHgetPRComment(comment);
    ci.setGHgetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    // tslint:disable-next-line:max-line-length
    expect(ci.addPRComment.mock.calls[0][1]).toMatch(/does not merge cleanly/);
});

test("handle comment submit email success", async () => {
    let { worktree,
          gggLocal,
          gggRemote,
    } = await setupRepos("s3");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const template = "fine template\r\nnew line";
    // add template to master repo
    await gggRemote.commit("temple",".github//PULL_REQUEST_TEMPLATE.md",
                           template);
    const A = await gggRemote.revParse("HEAD");
    expect(A).not.toBeUndefined();

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const B = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(["fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber: prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: A,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: `Super body\r\n${template}\r\nCc: Copy One <copy@cat.com>\r\nCc: Copy Two <copycat@cat.com>`,
        hasComments: true,
        headCommit: B,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    const { smtpUser } = await getSMTPInfo();

    if (smtpUser) {                 // if configured for this test
        ci.setGHgetPRInfo(prinfo);
        ci.setGHgetPRComment(comment);
        ci.setGHgetGitHubUserInfo(user);

        await ci.handleComment("gitgitgadget", 433865360);
        expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Submitted as/);
    }
});

test("handle comment preview email success", async () => {
    let { worktree,
          gggLocal,
          gggRemote,
    } = await setupRepos("p1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const template = "fine template\nnew line";
    await gggRemote.commit("temple",".github//PULL_REQUEST_TEMPLATE.md",
                           template);
    const A = await gggRemote.revParse("HEAD");
    expect(A).not.toBeUndefined();

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const B = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(["fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    let comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber: prNumber,
    };
    const user = {
        email: "preview@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const prinfo = {
        author: "ggg",
        baseCommit: A,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "There will be a submit email and a preview email.",
        hasComments: true,
        headCommit: B,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    const { smtpUser } = await getSMTPInfo();

    if (smtpUser) {                 // if configured for this test
        ci.setGHgetPRInfo(prinfo);
        ci.setGHgetPRComment(comment);
        ci.setGHgetGitHubUserInfo(user);

        await ci.handleComment("gitgitgadget", 433865360);
        expect(ci.addPRComment.mock.calls[0][1]).toMatch(/Submitted as/);

        comment.body = " /preview";
        ci.setGHgetPRComment(comment);
        await ci.handleComment("gitgitgadget", 433865360); // do it again
        // tslint:disable-next-line:max-line-length
        expect(ci.addPRComment.mock.calls[1][1]).toMatch(/Preview email sent as/);

        await ci.handleComment("gitgitgadget", 433865360); // should still be v2
    }
});
