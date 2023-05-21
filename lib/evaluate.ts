import assert from 'assert';
import * as fs from 'fs';
import * as stream from 'stream';
import csvparse from 'csv-parse';
import JSONStream from 'JSONStream';
import * as argparse from 'argparse';
import { waitFinish } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { StreamUtils } from 'genie-toolkit';

function safeDivide(x : number, y : number) {
    if (x === 0 && y === 0)
        return 1;
    else if (y === 0)
        return Infinity;
    return x/y;
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Evaluate the answer accuracy"
    });
    parser.add_argument('--dataset', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('--reevaluate', {
        action: 'store_true',
        default: false,
        help: 're-evaluate original SPARQL and update answers'
    });
    parser.add_argument('--from-thingtalk', {
        action: 'store_true',
        default: false,
        help: 'use converted thingtalk file instead of the original raw file'
    });
    parser.add_argument('--prediction', {
        required: true
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--save-cache', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    const args = parser.parse_args();
    const wikidata = new WikidataUtils(args.cache, args.bootleg_db, args.save_cache);
    const expectedSPARQL : Record<string, string> = {};
    const expectedAnswer : Record<string, string[]> = {};
    let dataset;
    if (args.from_thingtalk) {
        const columns = ['id', 'sentence', 'answers', 'sparql'];
        dataset = args.dataset.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
            .pipe(new StreamUtils.MapAccumulator());
        const data = await dataset.read(); 
        for (const ex of data.values()) {
            expectedSPARQL[ex.id] = ex.sparql;
            expectedAnswer[ex.id] = ex.sparql === 'NULL' ? [] : await wikidata.query(ex.sparql);
        }
    } else {
        dataset = args.dataset.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
        for await (const item of dataset) {
            expectedSPARQL[item.id] = item.query.sparql;
            if (args.reevaluate) {
                const sparql = item.query.sparql;
                expectedAnswer[item.id] = await wikidata.query(sparql);
            } else {
                assert(item.answers.length === 1);
                const answer = item.answers[0];
                expectedAnswer[item.id] = WikidataUtils.processRawResult(answer);
            }
        }
    }

    const predictions = fs.readFileSync(args.prediction, { encoding: 'utf8' }).split('\n');


    const WWQ = {
        queryExactMatch: 0,
        answerExactMatch: 0,
        F1sum: 0,
        total: 0
    };
    const WWQSP = {
        queryExactMatch: 0,
        total: 0
    };

    for (const line of predictions) {
        if (line.trim().length === 0)
            continue;
        WWQSP.total += 1;

        const [id, , answers, sparql] = line.split('\t');
        const expected = expectedAnswer[id];
        if (expected.length === 0) {
            if (sparql === expectedSPARQL[id])
                WWQSP.queryExactMatch += 1;
        } else {
            WWQ.total += 1;
            if (sparql === expectedSPARQL[id]) {
                WWQ.queryExactMatch += 1;
                WWQ.answerExactMatch += 1;
                WWQ.F1sum += 1;
                WWQSP.queryExactMatch += 1;
                continue;
            }

            const predicted = answers.length === 0 ? [] : answers.split(' ');
            const tp = predicted.filter((r) => expected.includes(r)).length;
            const fp = predicted.filter((r) => !expected.includes(r)).length;
            const fn = expected.filter((r) => !predicted.includes(r)).length;
            const precision = safeDivide(tp, tp + fp);
            const recall = safeDivide(tp, tp + fn);
            if (precision + recall === 0) {
                WWQ.F1sum += 0;
            } else { 
                const f1 = 2 * precision * recall / (precision + recall);
                WWQ.F1sum += f1;
                if (f1 === 1)
                    WWQ.answerExactMatch += 1;
            }
        }
    }
    console.log('WWQ');
    console.log('Total: ' + WWQ.total);
    console.log('Query Accuracy: ' + WWQ.queryExactMatch/WWQ.total);
    console.log('Answer Accuracy: ' + WWQ.answerExactMatch/WWQ.total);
    console.log('Answer F1: ' + WWQ.F1sum/WWQ.total);

    console.log('WWQSP');
    console.log('Total:' + WWQSP.total);
    console.log('Query Accuracy: ' + WWQSP.queryExactMatch/WWQSP.total);
    await waitFinish(dataset);
}

if (require.main === module)
    main();