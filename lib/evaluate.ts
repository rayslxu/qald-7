import assert from 'assert';
import * as fs from 'fs';
import * as stream from 'stream';
import JSONStream from 'JSONStream';
import * as argparse from 'argparse';
import { waitFinish } from './utils/misc';
import WikidataUtils from './utils/wikidata';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Evaluate the answer accuracy"
    });
    parser.add_argument('--dataset', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('--prediction', {
        required: true
    });
    const args = parser.parse_args();
    const dataset = args.dataset.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
    const expectedAnswer : Record<string, string[]> = {};
    for await (const item of dataset) {
        assert(item.answers.length === 1);
        const answer = item.answers[0];
        expectedAnswer[item.id] = WikidataUtils.processRawResult(answer);
    }

    const predictions = fs.readFileSync(args.prediction, { encoding: 'utf8' }).split('\n');
    const MicroF1s = [];
    let [MacroTP, MacroFP, MacroFN] = [0, 0, 0];
    for (const line of predictions) {
        const [id, , answers, ] = line.split('\t');
        const expected = expectedAnswer[id];
        const predicted = answers.split(' ');
        const TP = predicted.filter((r) => expected.includes(r)).length;
        MacroTP += TP;
        const FP = predicted.filter((r) => !expected.includes(r)).length;
        MacroFP += FP;
        const FN = expected.filter((r) => !predicted.includes(r)).length;
        MacroFN += FN;
        const F1 = TP / (TP + (FP + FN) / 2);
        MicroF1s.push(F1);
    }
    const MicroF1 = MicroF1s.reduce((sum, a) => sum += a, 0) / MicroF1s.length;
    const MacroF1 = MacroTP / (MacroTP + (MacroFP + MacroFN) / 2 );

    console.log('Micro F1: ', MicroF1);
    console.log('Macro F1: ', MacroF1);

    await waitFinish(dataset);
}

if (require.main === module)
    main();