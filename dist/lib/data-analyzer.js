"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Analyzer = void 0;
const argparse = __importStar(require("argparse"));
const fs_1 = __importDefault(require("fs"));
const stream_1 = __importDefault(require("stream"));
const byline_1 = __importDefault(require("byline"));
const Tp = __importStar(require("thingpedia"));
const ThingTalk = __importStar(require("thingtalk"));
const thingtalk_1 = require("thingtalk");
const genie_toolkit_1 = require("genie-toolkit");
const misc_1 = require("./utils/misc");
const wikidata_1 = require("./utils/wikidata");
class PropertyVisitor extends thingtalk_1.Ast.NodeVisitor {
    constructor() {
        super();
        this._projections = [];
        this._atom_filters = [];
        this._count = [];
    }
    _postprocess(properties) {
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
    visitProjectionExpression(node) {
        for (const p of node.args)
            this._projections.push(p);
        return true;
    }
    visitAtomBooleanExpression(node) {
        this._atom_filters.push(node.name);
        return true;
    }
    visitComputationValue(node) {
        if (node.op === 'count' && node.operands[0] instanceof thingtalk_1.Ast.VarRefValue)
            this._count.push(node.operands[0].name);
        return true;
    }
}
class Analyzer extends stream_1.default.Writable {
    constructor(classDef) {
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
    analyze(thingtalk) {
        for (const [property, result] of Object.entries(this._result)) {
            if (thingtalk.includes(' ' + property + ' '))
                result.num_total += 1;
        }
        const program = thingtalk_1.Syntax.parse(thingtalk, thingtalk_1.Syntax.SyntaxType.Normal, { timezone: undefined });
        const propertyVisitor = new PropertyVisitor();
        program.visit(propertyVisitor);
        for (const property of propertyVisitor.atom_filters)
            this._result[property].num_filter += 1;
        for (const property of propertyVisitor.count)
            this._result[property].num_count += 1;
        for (const property of propertyVisitor.projections)
            this._result[property].num_projection += 1;
    }
    _write(ex, encoding, callback) {
        this.analyze(ex.target_code);
        callback();
    }
    read() {
        return new Promise((resolve, reject) => {
            this.on('finish', () => resolve(this._result));
            this.on('error', reject);
        });
    }
}
exports.Analyzer = Analyzer;
async function main() {
    const parser = new argparse.ArgumentParser({
        add_help: true,
        description: "Analyze a generated dataset"
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
    parser.add_argument('--thingpedia', {
        required: true,
        help: 'Path to ThingTalk file containing class definitions.'
    });
    parser.add_argument('-i', '--input', {
        required: true,
        type: fs_1.default.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs_1.default.createWriteStream
    });
    const args = parser.parse_args();
    const tpClient = new Tp.FileClient(args);
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null);
    const analyzer = new Analyzer(await schemas.getFullMeta(wikidata_1.TP_DEVICE_NAME));
    const output = args.input.setEncoding('utf8').pipe((0, byline_1.default)())
        .pipe(new genie_toolkit_1.DatasetParser({ contextual: false, preserveId: true }))
        .pipe(analyzer);
    const result = await output.read();
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
    (0, misc_1.waitFinish)(args.output);
}
if (require.main === module)
    main();
//# sourceMappingURL=data-analyzer.js.map