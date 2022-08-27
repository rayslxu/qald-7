
import * as fs from 'fs';
import Stream from 'stream';
import JSONStream from 'JSONStream';
import * as argparse from 'argparse';
import byline from 'byline';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { I18n, DatasetParser, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { MANUAL_CONVERSION_WITH_DISPLAY, MANUAL_CONVERSION_WITHOUT_DISPLAY, MANUAL_SPARQL_REWRITE } from '../utils/qald';
import { waitFinish } from '../utils/misc';

import SPARQLToThingTalkConverter from "./sparql2thingtalk";
import ThingTalkToSPARQLConverter from './thingtalk2sparql';
import WikidataUtils, { TP_DEVICE_NAME } from '../utils/wikidata';

export {
    SPARQLToThingTalkConverter,
    ThingTalkToSPARQLConverter
};

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "A tool to convert QALD-7 SPARQL from/to ThingTalk"
    });
    parser.add_argument('--direction', {
        required: false,
        choices: ['from-thingtalk', 'to-thingtalk'],
        default: 'to-thingtalk',
        help: `The direction of conversion`
    });
    parser.add_argument('-l', '--locale', {
        required: false,
        default: 'en-US',
        help: `BGP 47 locale tag of the language to evaluate (defaults to 'en-US', English)`
    });
    parser.add_argument('--timezone', {
        required: false,
        default: 'utc',
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
    parser.add_argument('--save-cache', {
        action: 'store_true',
        default: false
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
    parser.add_argument('--domains', {
        required: false,
        default: 'domain.json',
        help: `Json file containing all domain entities`
    });
    parser.add_argument('--include-entity-value', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--exclude-entity-display', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--human-readable-instance-of', {
        action: 'store_true',
        help: 'Use human readable string for instance_of instead of QID.',
        default: false
    });
    const args = parser.parse_args();

    const tpClient = new Tp.FileClient({ thingpedia: './manifest.tt', locale: 'en' });
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null, true);
    const classDef = await schemas.getFullMeta(TP_DEVICE_NAME);
    const tokenizer = new I18n.LanguagePack('en').getTokenizer();

    if (args.direction === 'to-thingtalk') {
        const converter = new SPARQLToThingTalkConverter(classDef, args);
        const input = args.input.pipe(JSONStream.parse('questions.*')).pipe(new Stream.PassThrough({ objectMode: true }));
        const output = new DatasetStringifier();
        output.pipe(args.output);
        
        const manualConversion = args.exclude_entity_display ? MANUAL_CONVERSION_WITHOUT_DISPLAY : MANUAL_CONVERSION_WITH_DISPLAY;
        let counter = 0;
        for await (const item of input) {
            counter ++;
            if (counter < args.offset)
                continue;
            let preprocessed = tokenizer.tokenize(item.question[0].string).rawTokens.join(' ');
            // Add a hack to fix the tokenizer error for "U.S."
            preprocessed = preprocessed.replace("u . s .", "united states");
            try {
                let program;
                if (item.query.sparql in manualConversion) {
                    program = await ThingTalkUtils.parse(manualConversion[item.query.sparql], schemas);
                } else { 
                    let sparql = item.query.sparql;
                    if (sparql in MANUAL_SPARQL_REWRITE)
                        sparql = MANUAL_SPARQL_REWRITE[sparql];
                    program = await converter.convert(sparql, preprocessed);
                }
                await program.typecheck(schemas);
                const target_code = ThingTalkUtils.serializePrediction(
                    program, 
                    preprocessed,
                    EntityUtils.makeDummyEntities(preprocessed), 
                    { 
                        locale: 'en', 
                        timezone: undefined, 
                        includeEntityValue: args.include_entity_value, 
                        excludeEntityDisplay: args.exclude_entity_display
                    }
                ).join(' ');
                output.write({ id: item.id, preprocessed, target_code });
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
    } else {
        const domains = JSON.parse(fs.readFileSync(args.domains, { encoding: 'utf8' })).data;
        const converter = new ThingTalkToSPARQLConverter(classDef, domains, {
            locale: args.locale,
            timezone: 'utc',
            cache: args.cache,
            save_cache: args.save_cache,
            bootleg: args.bootleg_db,
            human_readable_instance_of: args.human_readable_instance_of
        });
        const wikidata = new WikidataUtils(args.cache, args.bootleg_db, args.save_cache);
        args.input.setEncoding('utf8').pipe(byline())
            .pipe(new Stream.Transform({
                objectMode: true,

                async transform(ex, encoding, callback) {
                    try {
                        const [id, utterance, , prediction] = ex.split('\t');
                        ex = [id, utterance, prediction].join('\t');
                        callback(null, ex);
                    } catch(e) {
                        console.log(e);
                        callback();
                    }
                },

                flush(callback) {
                    process.nextTick(callback);
                }
            }))
            .pipe(new DatasetParser({ contextual: false, preserveId: true }))
            .pipe(new Stream.Transform({
                objectMode: true,

                async transform(ex, encoding, callback) {
                    try {
                        ex.prediction = await converter.convert(ex.preprocessed, ex.target_code);
                        const result = await wikidata.query(ex.prediction);
                        if (typeof result === 'string' && ['true', 'false'].includes(result))
                            ex.target_code = result;
                        else if (Array.isArray(result) && result.length > 0)
                            ex.target_code = result.join(' ');
                        else 
                            ex.target_code = 'NULL';
                        callback(null, ex);
                    } catch(e) {
                        ex.target_code = '';
                        ex.predictions = ex.prediction ?? '';
                        callback(null, ex);
                    }
                },

                flush(callback) {
                    process.nextTick(callback);
                }
            }))
            .pipe(new DatasetStringifier())
            .pipe(args.output);
        waitFinish(args.output);
    }
}

if (require.main === module)
    main();