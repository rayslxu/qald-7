
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import assert from 'assert';
import * as stream from 'stream';
import JSONStream from 'JSONStream';
import * as argparse from 'argparse';
import { Ast } from 'thingtalk';
import * as ThingTalk from 'thingtalk';
import { I18n, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { MANUAL_CONVERSION } from '../utils/qald';
import { waitFinish } from '../utils/misc';

import SPARQLToThingTalkConverter from "./sparql2thingtalk";

export {
    SPARQLToThingTalkConverter
};


async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "A tool to convert QALD-7 SPARQL to ThingTalk"
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: undefined,
        help: `Timezone to use to interpret dates and times (defaults to the current timezone).`
    });
    parser.add_argument('--manifest', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('--cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg-db', {
        required: false,
        default: 'bootleg.sqlite'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('-d', '--drop', {
        required: false,
        type: fs.createWriteStream
    });
    parser.add_argument('--offset', {
        required: false,
        type: parseInt,
        default: 1,
        help: `Start from the nth example`
    });
    parser.add_argument('--include-entity-value', {
        action: 'store_true',
        default: false
    });
    const args = parser.parse_args();

    const manifest = await pfs.readFile(args.manifest, { encoding: 'utf8' });
    const library = ThingTalk.Syntax.parse(manifest, ThingTalk.Syntax.SyntaxType.Normal, { locale: args.locale, timezone: args.timezone });
    assert(library instanceof Ast.Library && library.classes.length === 1);
    const classDef = library.classes[0];
    const converter = new SPARQLToThingTalkConverter(classDef, { cache: args.cache, bootleg_db: args.bootleg_db });
    const tokenizer = new I18n.LanguagePack('en').getTokenizer();

    const input = args.input.pipe(JSONStream.parse('questions.*')).pipe(new stream.PassThrough({ objectMode: true }));
    const output = new DatasetStringifier();
    output.pipe(args.output);
    
    let counter = 0;
    for await (const item of input) {
        counter ++;
        if (counter < args.offset)
            continue;
        const preprocessed = tokenizer.tokenize(item.question[0].string).rawTokens.join(' ');
        try {
            if (item.query.sparql in MANUAL_CONVERSION) {
                output.write({ id: item.id, preprocessed, target_code: MANUAL_CONVERSION[item.query.sparql] });
            } else { 
                const program = await converter.convert(item.query.sparql, preprocessed);
                const target_code = ThingTalkUtils.serializePrediction(
                    program, 
                    preprocessed,
                    EntityUtils.makeDummyEntities(preprocessed),
                    { locale: 'en', timezone: undefined, includeEntityValue: args.include_entity_value }
                ).join(' ');
                output.write({ id: item.id, preprocessed, target_code });
            }
        } catch(e) {
            console.log(`Example ${item.id} failed`);
            if (args.drop)
                args.drop.write(`${item.id}\t${preprocessed}\t${item.query.sparql}\t${(e as Error).message.replace(/\s+/g, ' ')}\n`);
            else 
                console.log((e as Error).message);
        }
    }
    await waitFinish(input);
    await waitFinish(output);
    if (args.drop)
        await waitFinish(args.drop);
}

if (require.main === module)
    main();