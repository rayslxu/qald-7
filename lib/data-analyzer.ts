import * as argparse from 'argparse';
import fs from 'fs';
import Stream from 'stream';
import byline from 'byline';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast, Type, Syntax } from 'thingtalk';
import { DatasetParser } from 'genie-toolkit';
import { waitFinish } from './utils/misc';
import { TP_DEVICE_NAME } from './utils/wikidata';

class PropertyVisitor extends Ast.NodeVisitor {
    private _projections : string[];
    private _atom_filters : string[];
    private _count : string[];

    constructor() {
        super();
        this._projections = [];
        this._atom_filters = [];
        this._count = [];
    }

    private _postprocess(properties : string[]) {
        return properties.filter((p) => p !== 'count').map((p) => {
            if (p.startsWith('first.'))
                return p.slice('first.'.length);
            if (p.startsWith('second.'))
                return p.slice('second.'.length);
            return p;
        });
    }

    get projections() {
        return this._postprocess(this._projections);
    }

    get atom_filters() {
        return this._postprocess(this._atom_filters);
    }

    get count() {
        return this._postprocess(this._count);
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        for (const p of node.args)
            this._projections.push(p);
        return true;
    }

    visitAtomBooleanExpression(node : ThingTalk.Ast.AtomBooleanExpression) : boolean {
        this._atom_filters.push(node.name);
        return true;
    }

    visitComputationValue(node : ThingTalk.Ast.ComputationValue) : boolean {
        if (node.op === 'count' && node.operands[0] instanceof Ast.VarRefValue)
            this._count.push(node.operands[0].name);
        return true;
    }
}

interface SentenceExample {
    target_code : string
}

interface AnalyzeResult {
    type : Type,
    num_projection : number;
    num_filter : number;
    num_count : number;
    num_total : number;
}

export class Analyzer extends Stream.Writable {
    private _classDef : Ast.ClassDef;
    private _result : Record<string, AnalyzeResult>;

    constructor(classDef : Ast.ClassDef) {
        super({ objectMode: true });
        this._classDef = classDef;
        this._result = {};
        const query = this._classDef.queries['entity'];
        for (const arg of query.iterateArguments()) {
            if (arg.name.includes('.'))
                continue;
            this._result[arg.name] = {
                type: arg.type,
                num_projection: 0,
                num_filter: 0,
                num_count: 0,
                num_total: 0
            };
        }
    }

    analyze(thingtalk : string) {
        for (const [property, result] of Object.entries(this._result)) {
            if (thingtalk.includes(' ' + property + ' '))
                result.num_total += 1;
        }
        const program = Syntax.parse(thingtalk, Syntax.SyntaxType.Normal, { timezone: undefined });
        const propertyVisitor = new PropertyVisitor();
        program.visit(propertyVisitor);
        for (const property of propertyVisitor.atom_filters) 
            this._result[property].num_filter += 1;
        for (const property of propertyVisitor.count)
            this._result[property].num_count += 1;
        for (const property of propertyVisitor.projections)
            this._result[property].num_projection += 1;
        
    }

    _write(ex : SentenceExample, encoding : BufferEncoding, callback : () => void) {
        this.analyze(ex.target_code);
        callback();
    }

    read() {
        return new Promise<Record<string, AnalyzeResult>>((resolve, reject) => {
            this.on('finish', () => resolve(this._result));
            this.on('error', reject);
        });
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Analyze a generated dataset"
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
    const analyzer = new Analyzer(await schemas.getFullMeta(TP_DEVICE_NAME),);

    const output = args.input.setEncoding('utf8').pipe(byline())
        .pipe(new DatasetParser({ contextual: false, preserveId: true }))
        .pipe(analyzer);
    const result : Record<string, AnalyzeResult> = await output.read();
    for (const [property, analyzeResult] of Object.entries(result)) {
        args.output.write([
            property,
            analyzeResult.num_filter,
            analyzeResult.num_projection,
            analyzeResult.num_count,
            analyzeResult.num_total,
            analyzeResult.type,
        ].join('\t') + '\n');
    }
    waitFinish(args.output);
}

if (require.main === module)
    main();