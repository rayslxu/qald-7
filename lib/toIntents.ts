import assert from 'assert';
import * as argparse from 'argparse';
import fs from 'fs';
import Stream from 'stream';
import byline from 'byline';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast } from 'thingtalk';
import { DatasetParser, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { waitFinish } from './utils/misc';
import { TP_DEVICE_NAME } from './utils/wikidata';

class GetFunctionVisitor extends Ast.NodeVisitor {
    names : string[] = [];

    visitInvocation(invocation : Ast.Invocation) {
        this.names.push(invocation.channel);
        return true;
    }
}

function getFunctionNames(ast : Ast.Node) : string[] {
    const visitor = new GetFunctionVisitor();
    ast.visit(visitor);
    return visitor.names;
}

class GetIdFilterVisitor extends Ast.NodeVisitor {
    filters : string[] = [];

    private _extractIdFilter(ast : Ast.BooleanExpression) : string|null {
        if (ast instanceof Ast.OrBooleanExpression) {
            for (const operand of ast.operands) {
                const idFilter = this._extractIdFilter(operand);
                if (idFilter)
                    return idFilter;
            }
        }
        if (ast instanceof Ast.AtomBooleanExpression) {
            if (ast.name === 'id') {
                assert(ast.value instanceof Ast.Value.Entity);
                ast.value.type = `${TP_DEVICE_NAME}:entity`;
                return `id = ${ast.value.display}`;
            }
        }
        return null;
    }

    visitFilterExpression(ast : Ast.FilterExpression) {
        const idFilter = this._extractIdFilter(ast.filter);
        if (idFilter)
            this.filters.push(idFilter);
        return true;
    }
}

function getIdFilters(ast : Ast.Node) : string[] {
    const visitor = new GetIdFilterVisitor();
    ast.visit(visitor);
    return visitor.filters;
}

interface ThingTalkToIntentConverterOptions {
    tpClient : Tp.BaseClient;
    schemas : ThingTalk.SchemaRetriever;
}

class ThingTalkToIntentConverter {
    private _tpClient : Tp.BaseClient;
    private _schemas : ThingTalk.SchemaRetriever;

    constructor(options : ThingTalkToIntentConverterOptions) {
        this._tpClient = options.tpClient;
        this._schemas = options.schemas;
    }

    async convert(thingtalk : string, preprocessedUtterance : string) : Promise<string> {
        const entities = EntityUtils.makeDummyEntities(preprocessedUtterance);
        const program = await ThingTalkUtils.parsePrediction(thingtalk.split(' '), entities, {
            timezone : undefined,
            thingpediaClient: this._tpClient,
            schemaRetriever : this._schemas
        });
        // skip program that does not type check. 
        // TODO: fix typechecking
        if (!program)
            return thingtalk;
        assert(program instanceof Ast.Program);
        const functions = getFunctionNames(program);
        const idFilters = getIdFilters(program);
        return [...functions, ...idFilters].join(', ');
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Convert thingtalk annotated data into intents and slots"
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
    parser.add_argument('--thingpedia', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });

    const args = parser.parse_args();
    const tpClient = new Tp.FileClient(args);
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null);
    const converter = new ThingTalkToIntentConverter({ tpClient, schemas });

    args.input.setEncoding('utf8').pipe(byline())
        .pipe(new DatasetParser({ contextual: false, preserveId: true }))
        .pipe(new Stream.Transform({
            objectMode: true,

            async transform(ex, encoding, callback) {
                const intent = await converter.convert(ex.target_code, ex.preprocessed);
                ex.target_code = intent;
                callback(null, ex);
            },

            flush(callback) {
                process.nextTick(callback);
            }
        }))
        .pipe(new DatasetStringifier())
        .pipe(args.output);
    waitFinish(args.output);
}

if (require.main === module)
    main();