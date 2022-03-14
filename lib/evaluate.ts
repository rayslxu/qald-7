import assert from 'assert';
import * as fs from 'fs';
import * as stream from 'stream';
import JSONStream from 'JSONStream';
import * as argparse from 'argparse';
import { waitFinish } from './utils/misc';

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Estimate the answer accuracy lower bound given the thingtalk results"
    });
    parser.add_argument('--dataset', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('--converted', {
        required: true
    });
    parser.add_argument('--result', {
        required: true
    });
    const args = parser.parse_args();
    const dataset = args.dataset.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
    const answerLength : Record<string, number> = {};
    for await (const item of dataset) {
        assert(item.answers.length === 1);
        const answer = item.answers[0];
        answerLength[item.id] = 'results' in answer ? answer.results.bindings.length : 1;
    }
    const total = Object.keys(answerLength).length;

    const converted = fs.readFileSync(args.converted, { encoding: 'utf8' });
    const convertedIds = converted.split('\n').filter((line) => line.trim().length > 0).map((line) => line.split('\t')[0]);
    const result = fs.readFileSync(args.result, { encoding: 'utf-8' });
    const incorrectIds = result.split('\n').filter((line) => line.trim().length > 0).map((line) => line.split('\t')[0]);
    
    let TP = 0, FN = 0;
    for (const [id, length] of Object.entries(answerLength)) {
        if (incorrectIds.includes(id) || !convertedIds.includes(id)) 
            FN += length;
        else 
            TP += length;
    }
    const precision = 1;
    const recall = TP / (TP + FN);
    const microF1 = 2 * precision * recall / ( precision + recall );
    console.log(`${(convertedIds.length / total * 100).toFixed(2)}% examples converted.`);
    console.log('Micro F1: ', microF1);
    console.log('Macro F1: ', (convertedIds.length - incorrectIds.length) / total);

    await waitFinish(dataset);
}

if (require.main === module)
    main();