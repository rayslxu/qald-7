import assert from 'assert';
import * as fs from 'fs';
import * as stream from 'stream';
import csvparse from 'csv-parse';
import JSONStream from 'JSONStream';
import * as argparse from 'argparse';
import { waitFinish } from './utils/misc';
import WikidataUtils from './utils/wikidata';
import { StreamUtils } from 'genie-toolkit';

function sum(x : number[]) {
    return x.reduce((sum, a) => sum += a, 0);
}

function avg(x : number[]) {
    return sum(x) / x.length;
}

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
    const expectedAnswer : Record<string, string[]> = {};
    let dataset;
    if (args.from_thingtalk) {
        const columns = ['id', 'sentence', 'answers', 'sparql'];
        dataset = args.dataset.pipe(csvparse({ columns, delimiter: '\t', relax: true }))
            .pipe(new StreamUtils.MapAccumulator());
        const data = await dataset.read(); 
        for (const ex of data.values()) 
            expectedAnswer[ex.id] = await wikidata.query(ex.sparql);
    } else {
        dataset = args.dataset.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
        for await (const item of dataset) {
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
    const TP : number[] = [];
    const FP : number[] = [];
    const FN : number[] = [];
    for (const line of predictions) {
        if (line.trim().length === 0)
            continue;
        const [id, , answers, ] = line.split('\t');
        const expected = expectedAnswer[id];
        const predicted = answers.split(' ');
        TP.push(predicted.filter((r) => expected.includes(r)).length);
        FP.push(predicted.filter((r) => !expected.includes(r)).length);
        FN.push(expected.filter((r) => !predicted.includes(r)).length);
    }

    const microF1 = sum(TP) / (sum(TP) + (sum(FP) + sum(FN)) / 2);
    const macroPrecision = avg([...Array(TP.length).keys()].map((i) => safeDivide(TP[i], (TP[i] + FP[i]))));
    const macroRecall = avg([...Array(TP.length).keys()].map((i) => safeDivide(TP[i], (TP[i] + FN[i]))));
    const macroF1 = 2 * macroPrecision * macroRecall / (macroPrecision + macroRecall);
    console.log('Micro F1: ', microF1);
    console.log('Macro F1: ', macroF1);
    console.log('Macro Precision: ', macroPrecision);
    console.log('Macro Recall: ', macroRecall);
    await waitFinish(dataset);
}

if (require.main === module)
    main();