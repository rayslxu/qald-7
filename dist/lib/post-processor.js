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
exports.PostProcessor = void 0;
const argparse = __importStar(require("argparse"));
const fs_1 = __importDefault(require("fs"));
const stream_1 = __importDefault(require("stream"));
const byline_1 = __importDefault(require("byline"));
const Tp = __importStar(require("thingpedia"));
const ThingTalk = __importStar(require("thingtalk"));
const thingtalk_1 = require("thingtalk");
const genie_toolkit_1 = require("genie-toolkit");
const misc_1 = require("./utils/misc");
const thingtalk_2 = require("./utils/thingtalk");
const wikidata_1 = require("./utils/wikidata");
function hasFilter(ast, property) {
    if (ast instanceof thingtalk_1.Ast.OrBooleanExpression)
        return ast.operands.every((op) => hasFilter(op, property));
    if (ast instanceof thingtalk_1.Ast.AndBooleanExpression)
        return false;
    if (ast instanceof thingtalk_1.Ast.NotBooleanExpression)
        return false;
    if (ast instanceof thingtalk_1.Ast.AtomBooleanExpression) {
        if (ast.name === property)
            return true;
    }
    if (ast instanceof thingtalk_1.Ast.ComparisonSubqueryBooleanExpression) {
        if (ast.lhs instanceof thingtalk_1.Ast.Value.VarRef && ast.lhs.name === property)
            return true;
    }
    return false;
}
class NormalizerVisitor extends thingtalk_1.Ast.NodeVisitor {
    constructor(klass, options) {
        super();
        this._class = klass;
        this._normalizeDomains = options.normalizeDomains;
        this._normalizeEntityTypes = options.normalizeEntityTypes;
    }
    _instanceOfFilter(invocation) {
        const domain = invocation.invocation.channel;
        const display = this._class.getFunction('query', domain).canonical[0];
        return (0, thingtalk_2.instanceOfFilter)(display, `${wikidata_1.TP_DEVICE_NAME}:entity`);
    }
    _addInstanceOfFilter(invocation) {
        if (invocation.invocation.channel === 'entity')
            return invocation;
        const filter = this._instanceOfFilter(invocation);
        return new thingtalk_1.Ast.FilterExpression(null, invocation, filter, null);
    }
    visitInvocationExpression(invocation) {
        if (this._normalizeDomains === 'always')
            invocation.invocation.channel = 'entity';
        return true;
    }
    visitAggregationExpression(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitBooleanQuestionExpression(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitJoinExpression(node) {
        if (this._normalizeDomains === 'always') {
            if (node.lhs instanceof thingtalk_1.Ast.InvocationExpression)
                node.lhs = this._addInstanceOfFilter(node.lhs);
            if (node.rhs instanceof thingtalk_1.Ast.InvocationExpression)
                node.rhs = this._addInstanceOfFilter(node.rhs);
        }
        return true;
    }
    visitIndexExpression(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitSortExpression(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitSliceExpression(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitProjectionExpression(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitProjectionExpression2(node) {
        if (this._normalizeDomains === 'always' && node.expression instanceof thingtalk_1.Ast.InvocationExpression)
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }
    visitFilterExpression(node) {
        if (this._normalizeDomains === 'id-filtered-only' && hasFilter(node.filter, 'id')) {
            const invocation = node.expression.invocation;
            invocation.channel = 'entity';
        }
        else if (this._normalizeDomains === 'always') {
            const invocationExpression = node.expression;
            if (invocationExpression.invocation.channel === 'entity')
                return true;
            if (!hasFilter(node.filter, 'id') && !hasFilter(node.filter, 'instance_of')) {
                node.filter = new thingtalk_1.Ast.AndBooleanExpression(null, [this._instanceOfFilter(invocationExpression), node.filter]);
            }
            invocationExpression.invocation.channel = 'entity';
        }
        return true;
    }
    visitAtomBooleanExpression(node) {
        if (node.name === 'instance_of' && node.value instanceof thingtalk_1.Ast.EntityValue) {
            node.value.type = `${wikidata_1.TP_DEVICE_NAME}:domain`;
            return false;
        }
        return true;
    }
    visitEntityValue(value) {
        if (this._normalizeEntityTypes)
            value.type = `${wikidata_1.TP_DEVICE_NAME}:entity`;
        else if (this._normalizeDomains !== 'never' && !value.type.startsWith(`${wikidata_1.TP_DEVICE_NAME}:p_`))
            value.type = `${wikidata_1.TP_DEVICE_NAME}:entity`;
        return true;
    }
}
class PostProcessor {
    constructor(options) {
        this._tpClient = options.tpClient;
        this._schemas = options.schemas;
        this._normalizer = new NormalizerVisitor(options.class, options);
        this._includeEntityValue = options.includeEntityValue;
        this._excludeEntityDisplay = options.excludeEntityDisplay;
    }
    async postprocess(thingtalk, preprocessedUtterance) {
        const entities = genie_toolkit_1.EntityUtils.makeDummyEntities(preprocessedUtterance);
        const program = await genie_toolkit_1.ThingTalkUtils.parsePrediction(thingtalk.split(' '), entities, {
            timezone: undefined,
            thingpediaClient: this._tpClient,
            schemaRetriever: this._schemas
        });
        // skip program that does not type check. 
        // TODO: fix typechecking
        if (!program)
            return thingtalk.split(' ');
        program.visit(this._normalizer);
        return genie_toolkit_1.ThingTalkUtils.serializePrediction(program.optimize(), preprocessedUtterance, entities, {
            locale: 'en',
            timezone: undefined,
            includeEntityValue: this._includeEntityValue,
            excludeEntityDisplay: this._excludeEntityDisplay
        });
    }
}
exports.PostProcessor = PostProcessor;
async function main() {
    const parser = new argparse.ArgumentParser({
        add_help: true,
        description: "Post process generated data"
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
    parser.add_argument('--normalize-domains', {
        choices: ['always', 'id-filtered-only', 'never'],
        default: 'id-filtered-only'
    });
    parser.add_argument('--normalize-entity-types', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--include-entity-value', {
        action: 'store_true',
        default: false
    });
    parser.add_argument('--exclude-entity-display', {
        action: 'store_true',
        default: false
    });
    const args = parser.parse_args();
    const tpClient = new Tp.FileClient(args);
    const schemas = new ThingTalk.SchemaRetriever(tpClient, null);
    const processor = new PostProcessor({
        tpClient,
        schemas,
        class: await schemas.getFullMeta(wikidata_1.TP_DEVICE_NAME),
        normalizeDomains: args.normalize_domains,
        normalizeEntityTypes: args.normalize_entity_types,
        includeEntityValue: args.include_entity_value,
        excludeEntityDisplay: args.exclude_entity_display
    });
    args.input.setEncoding('utf8').pipe((0, byline_1.default)())
        .pipe(new genie_toolkit_1.DatasetParser({ contextual: false, preserveId: true }))
        .pipe(new stream_1.default.Transform({
        objectMode: true,
        async transform(ex, encoding, callback) {
            try {
                const postprocessed = await processor.postprocess(ex.target_code, ex.preprocessed);
                ex.target_code = postprocessed.join(' ');
                callback(null, ex);
            }
            catch (e) {
                callback();
            }
        },
        flush(callback) {
            process.nextTick(callback);
        }
    }))
        .pipe(new genie_toolkit_1.DatasetStringifier())
        .pipe(args.output);
    (0, misc_1.waitFinish)(args.output);
}
if (require.main === module)
    main();
//# sourceMappingURL=post-processor.js.map