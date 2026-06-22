import { ActiveCode } from "./activecode.js";
import { makeEmbedConfig } from "pyret-embed";

// PyretActiveCode -- Pyret ActiveCode handler for RunestoneComponents.
//
// Architectural overview:
//   - pyret-embed (https://github.com/jpolitz/pyret-embed) ships a complete,
//     prebuilt copy of the Pyret web IDE (code.pyret.org) as an npm package.
//     Its dist/build/web directory is copied as-is into the static output by
//     webpack.config.js's CopyPlugin and served at _static/pyret-embed/.
//   - Unlike GDScript's Godot shell, this does not speak a hand-rolled
//     postMessage protocol -- pyret-embed exposes a documented API
//     (makeEmbedConfig, see types/pyret.d.ts in the package) that's driven
//     directly: sendReset() loads code into the embedded editor,
//     runDefinitions() runs it, and setInteractions()+runInteractionResult()
//     evaluates a REPL interaction and returns its rendered output as text.
//   - The embed's own UI (its code editor, REPL
//     input, and footer chrome) is hidden entirely (hideDefinitions,
//     hideInteractions, footerStyle: "hide"); the Runestone Run button and
//     this.output area are the only visible controls, matching every other
//     ActiveCode language. There's no "headerStyle" option in the typed
//     EmbedConfig, so header chrome may still render inside the (otherwise
//     invisible) iframe -- harmless since the iframe itself is hidden, but
//     worth knowing if this is ever made partially visible later.
//   - Grade passback: runDefinitions()/sendReset() are fire-and-forget with
//     no result. The ONLY pyret-embed call that returns data is
//     runInteractionResult(), so the full program (prefix+code+suffix, via
//     the existing buildProg(true)) is run as a single REPL interaction
//     rather than as "definitions". Pyret's REPL allows top-level
//     definitions in an interaction the same as in the definitions pane, so
//     this should be semantically equivalent -- but this specific point,
//     along with the timing between runDefinitions() and the interaction
//     call below, has not been verified against a real browser and is worth
//     checking once this is wired in.
//   - The result text contains Pyret's own check-block rendering (see
//     js/check-ui.js in the pyret-embed package), including "Test N:
//     Passed"/"Test N: Failed" lines per check, which are counted directly
//     for the pass/fail summary and grade, with a fallback for the
//     1-test/2-test/all-N-tests "Looks shipshape..." phrasing check-ui.js
//     uses instead of per-test headers when every test in the block passed.
//   - This relies on the JSON.parse(textResult) => {texts, htmls} shape from
//     pyret-embed's internal js/events.js, and the exact wording in
//     js/check-ui.js -- neither is part of pyret-embed's typed public API.
//     The dependency is pinned to an exact version (0.0.57) in package.json
//     for this reason; re-check this parsing logic against check-ui.js if
//     that version ever changes.

const PYRET_EMBED_STATIC_DIR = "pyret-embed"; // must match the "to" folder in webpack.config.js's CopyPlugin entry

function pyretEmbedSrc() {
    var bookprefix = window.location.href.substring(0, window.location.href.lastIndexOf('/'));
    if (
        eBookConfig.useRunestoneServices ||
        window.location.search.includes("mode=browsing")
    ) {
        // On a Runestone server, prefix with the published book path,
        // mirroring how GodotActiveCode resolves shellBase.
        bookprefix = `${bookprefix}/ns/books/published/${eBookConfig.basecourse}`;
    }
    return `${bookprefix}/_static/${PYRET_EMBED_STATIC_DIR}/editor.embed.html#headerStyle=hide`;
}

export default class PyretActiveCode extends ActiveCode {
    constructor(opts) {
        super(opts);

        // unit_results string for logBookEvent, same format as SQL/Godot.
        this.unit_results = null;
        this.testResult = false;

        // Container for the embed iframe. This is
        // never shown -- kept tiny, transparent, and out of the tab order
        // rather than display:none, since some browsers throttle timers and
        // rAF inside fully display:none iframes, and pyret-embed's internal
        // message handling may depend on that continuing to run normally.
        var embedContainer = document.createElement("div");
        embedContainer.style.position = "relative";
        embedContainer.style.width = "100%";
        embedContainer.style.height = "400px";
        embedContainer.style.opacity = "1";
        //embedContainer.style.overflow = "hidden";
        embedContainer.style.pointerEvents = "none";
        this.outDiv.parentNode.insertBefore(embedContainer, this.outDiv);
        this.embedContainer = embedContainer;

        // Results table container, inserted between the embed container and
        // the plain-text output div, mirroring GodotActiveCode's
        // unitResultsDiv (same ac-feedback* CSS classes, so this picks up
        // the site's existing styling with no new stylesheet).
        var resultsDiv = document.createElement("div");
        resultsDiv.classList.add("unittest-results");
        resultsDiv.id = this.divid + "_unit_results";
        resultsDiv.style.display = "none";
        this.outDiv.parentNode.insertBefore(resultsDiv, this.outDiv);
        this.unitResultsDiv = resultsDiv;

        // Kick off the embed load now so it's ready by the time the student
        // clicks Run. makeEmbedConfig's returned promise already resolves
        // only once the iframe has loaded and completed its internal ready
        // handshake, so -- unlike GodotActiveCode's hand-rolled
        // shellReady/_pendingRun queue -- runProg() can simply await this
        // promise directly with no separate readiness tracking needed.
        this._embedReady = makeEmbedConfig({
            container: embedContainer,
            src: pyretEmbedSrc(),
            options: {
                footerStyle: "hide",
                hideDefinitions: true,
                hideInteractions: false,
                warnOnExit: false,
            },
        });
    }

    // -------------------------------------------------------------------------
    // Parses the JSON {texts, htmls} shape that pyret-embed's
    // runInteractionResult() returns, and counts "Test N: Passed"/
    // "Test N: Failed" occurrences for the pass/fail summary. Falls back to
    // check-ui.js's celebratory all-passed phrasing when there are no
    // per-test headers at all -- either because there were no check:/
    // examples: blocks in the program, or because check-ui.js uses that
    // phrasing instead of per-test headers for 1 or 2 passing tests.
    // -------------------------------------------------------------------------
    _parseCheckResults(rawResult) {
        var texts = [];
        try {
            var parsed = JSON.parse(rawResult);
            texts = parsed.texts || [];
        } catch (e) {
            // Not JSON for some reason -- fall back to treating it as plain text
            // rather than losing the output entirely.
            texts = [String(rawResult)];
        }
        var joined = texts.join("\n");

        var testHeaders = joined.match(/Test \d+: (Passed|Failed)/g) || [];
        var passed = testHeaders.filter((h) => h.endsWith("Passed")).length;
        var failed = testHeaders.filter((h) => h.endsWith("Failed")).length;

        if (testHeaders.length === 0) {
            if (/Looks shipshape, your test passed/.test(joined)) {
                passed = 1;
            } else if (/Looks shipshape, both tests passed/.test(joined)) {
                passed = 2;
            } else {
                var allPassedMatch = joined.match(
                    /Looks shipshape, all (\d+) tests passed/
                );
                if (allPassedMatch) {
                    passed = parseInt(allPassedMatch[1], 10);
                }
            }
        }

        return {
            passed: passed,
            failed: failed,
            total: passed + failed,
            testHeaders: testHeaders,
            rawText: joined,
        };
    }

    // -------------------------------------------------------------------------
    // Builds the results table into this.unitResultsDiv, mirroring the same
    // ac-feedback / ac-feedback-pass / ac-feedback-fail structure
    // GodotActiveCode uses (in turn mirroring Python's unittest.gui table).
    // -------------------------------------------------------------------------
    _renderResultsTable(results) {
        var container = this.unitResultsDiv;
        container.innerHTML = "";

        if (results.total === 0) {
            // No check:/examples: blocks ran at all -- nothing to tabulate.
            container.style.display = "none";
            return;
        }

        var table = document.createElement("table");
        var headerRow = document.createElement("tr");
        for (let label of ["Result", "Test"]) {
            var th = document.createElement("th");
            th.classList.add("ac-feedback");
            th.style.textAlign = "center";
            th.textContent = label;
            headerRow.appendChild(th);
        }
        table.appendChild(headerRow);

        if (results.testHeaders.length > 0) {
            for (let header of results.testHeaders) {
                this._appendResultRow(table, header.endsWith("Passed"), header);
            }
        } else {
            // Celebratory single/double/N-tests-passed phrasing -- no
            // per-test headers to enumerate individually.
            this._appendResultRow(
                table,
                true,
                `${results.passed} of ${results.total} tests passed`
            );
        }

        container.appendChild(table);

        var pct = Math.round((results.passed / results.total) * 100);
        var summary = document.createElement("p");
        summary.textContent = `You passed: ${pct}% of the tests (${results.passed}/${results.total})`;
        container.appendChild(summary);

        container.style.display = "block";
    }

    // -------------------------------------------------------------------------
    // Appends a single result row to the table.
    // -------------------------------------------------------------------------
    _appendResultRow(table, isPass, description) {
        var row = document.createElement("tr");

        var resultCell = document.createElement("td");
        resultCell.classList.add(
            "ac-feedback",
            isPass ? "ac-feedback-pass" : "ac-feedback-fail"
        );
        resultCell.style.textAlign = "center";
        resultCell.textContent = isPass ? "Pass" : "Fail";
        row.appendChild(resultCell);

        var descCell = document.createElement("td");
        descCell.classList.add("ac-feedback");
        descCell.textContent = description || "";
        row.appendChild(descCell);

        table.appendChild(row);
    }

    // -------------------------------------------------------------------------
    // Override runProg() -- called when the student clicks Run. noUI is
    // accepted but, following GodotActiveCode's precedent, not acted on;
    // only Skulpt-based languages currently implement noUI-specific
    // suppression.
    // -------------------------------------------------------------------------
    async runProg(noUI, logResults) {
        this.logResults = typeof logResults === "undefined" ? true : logResults;

        $(this.output).text("Running…");
        $(this.output).css("visibility", "visible");
        $(this.output).removeClass("error");

        this.unitResultsDiv.innerHTML = "";
        this.unitResultsDiv.style.display = "none";

        // prefix + student code + suffix, exactly as every other ActiveCode
        // language assembles it -- the hidden suffix (if any) is whatever
        // test/check code the exercise author attached via Runestone's
        // standard prefix/suffix markers, run together with the student's
        // own code and any where:/check: clauses already inside it.
        var prog = await this.buildProg(false);
        var test = typeof this.suffix === "undefined" ?  "'no tests.'" : this.suffix 

        try {
            var embed = await this._embedReady;
            embed.sendReset({
                definitionsAtLastRun: "",
                interactionsSinceLastRun: [],
                editorContents: "use context starter2024\n\n" + prog,
                replContents: "",
            });
            embed.runDefinitions();
            embed.setInteractions(test);
            var rawResult = await embed.runInteractionResult();
            var results = this._parseCheckResults(rawResult);

            this.unit_results = `percent:${
                results.total > 0
                    ? Math.round((results.passed / results.total) * 100)
                    : 100
            }:passed:${results.passed}:failed:${results.failed}`;
            this.testResult = results.failed === 0;

            this._renderResultsTable(results);

            // Always show the full raw output -- print() output, error
            // messages, and check detail all arrive commingled in the same
            // scraped text, so nothing is hidden, with a one-line summary
            // prepended only when there were checks to summarize.
            var summaryLine =
                results.total > 0
                    ? `You passed: ${results.passed}/${results.total} tests\n\n`
                    : "";
            $(this.output).text(
                summaryLine + (results.rawText.trim() || "(no output)")
            );
        } catch (e) {
            $(this.output).text("Error running Pyret code: " + e.message);
            $(this.output).addClass("error");
            this.unit_results = null;
            this.testResult = false;
        }
        $(this.output).css("visibility", "visible");

        return Promise.resolve("done");
    }

    // -------------------------------------------------------------------------
    // Override logCurrentAnswer() to also log the unittest result,
    // mirroring GodotActiveCode/SQL.
    // -------------------------------------------------------------------------
    async logCurrentAnswer(sid) {
        let data = {
            div_id: this.divid,
            code: this.editor.getValue(),
            language: this.language,
            errinfo: this.testResult ? "passed" : "failed",
            to_save: this.saveCode,
            prefix: this.pretext,
            suffix: this.suffix,
            partner: this.partner,
        };
        if (typeof sid !== "undefined") {
            data.sid = sid;
        }
        await this.logRunEvent(data);

        if (this.unit_results) {
            let unitData = {
                event: "unittest",
                div_id: this.divid,
                course: eBookConfig.course,
                act: this.unit_results,
            };
            if (typeof sid !== "undefined") {
                unitData.sid = sid;
            }
            await this.logBookEvent(unitData);
        }
    }
}
