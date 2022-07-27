import * as argparse from 'argparse';
import fs from 'fs';
import Stream from 'stream';
import byline from 'byline';
import * as Tp from 'thingpedia';
import * as ThingTalk from 'thingtalk';
import { Ast } from 'thingtalk';
import { DatasetParser, DatasetStringifier, ThingTalkUtils, EntityUtils } from 'genie-toolkit';
import { waitFinish } from './utils/misc';
import { instanceOfFilter } from './utils/thingtalk';

function hasFilter(ast : Ast.BooleanExpression, property : string) : boolean {
    if (ast instanceof Ast.OrBooleanExpression)
        return ast.operands.every((op) => hasFilter(op, property));
    if (ast instanceof Ast.AndBooleanExpression)
        return false;
    if (ast instanceof Ast.NotBooleanExpression)
        return false;
    if (ast instanceof Ast.AtomBooleanExpression) {
        if (ast.name === property) 
            return true;
    } 
    if (ast instanceof Ast.ComparisonSubqueryBooleanExpression) {
        if (ast.lhs instanceof Ast.Value.VarRef && ast.lhs.name === property)
            return true;
    }
    return false;
}

class NormalizerVisitor extends Ast.NodeVisitor {
    private _class : Ast.ClassDef;
    private _normalizeDomains : 'always'|'id-filtered-only'|'never';
    private _normalizeEntityTypes : boolean;

    constructor(
        klass : Ast.ClassDef,
        options : { 
        normalizeDomains : 'always'|'id-filtered-only'|'never', 
        normalizeEntityTypes : boolean;
    }) {
        super();
        this._class = klass;
        this._normalizeDomains = options.normalizeDomains;
        this._normalizeEntityTypes = options.normalizeEntityTypes;
    }

    private _instanceOfFilter(invocation : Ast.InvocationExpression) : Ast.BooleanExpression {
        const domain = invocation.invocation.channel;
        const QID = this._class.getFunction('query', domain)!.getImplementationAnnotation('wikidata_subject') as string;
        const display = this._class.getFunction('query', domain)!.canonical!;
        const value = new Ast.EntityValue(QID[0], 'org.wikidata:entity', display[0]);
        return instanceOfFilter(value);
    }

    private _addInstanceOfFilter(invocation : Ast.InvocationExpression) : Ast.Expression {
        if (invocation.invocation.channel === 'entity')
            return invocation;
        const filter = this._instanceOfFilter(invocation);
        return new Ast.FilterExpression(null, invocation, filter, null);
    }

    visitInvocationExpression(invocation : Ast.InvocationExpression) {
        if (this._normalizeDomains === 'always') 
            invocation.invocation.channel = 'entity';
        return true;
    }

    visitAggregationExpression(node : ThingTalk.Ast.AggregationExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitBooleanQuestionExpression(node : ThingTalk.Ast.BooleanQuestionExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitJoinExpression(node : ThingTalk.Ast.JoinExpression) : boolean {
        if (this._normalizeDomains === 'always') {
            if (node.lhs instanceof Ast.InvocationExpression) 
                node.lhs = this._addInstanceOfFilter(node.lhs);
            if (node.rhs instanceof Ast.InvocationExpression) 
                node.rhs = this._addInstanceOfFilter(node.rhs);
        }
        return true;
    }

    visitIndexExpression(node : ThingTalk.Ast.IndexExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitSortExpression(node : ThingTalk.Ast.SortExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitSliceExpression(node : ThingTalk.Ast.SliceExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitProjectionExpression(node : ThingTalk.Ast.ProjectionExpression) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitProjectionExpression2(node : ThingTalk.Ast.ProjectionExpression2) : boolean {
        if (this._normalizeDomains === 'always' && node.expression instanceof Ast.InvocationExpression) 
            node.expression = this._addInstanceOfFilter(node.expression);
        return true;
    }

    visitFilterExpression(node : Ast.FilterExpression) : boolean {
        if (this._normalizeDomains === 'id-filtered-only' && hasFilter(node.filter, 'id')) {
            const invocation = (node.expression as Ast.InvocationExpression).invocation;
            invocation.channel = 'entity';
        } else if (this._normalizeDomains === 'always') {
            const invocationExpression = node.expression as Ast.InvocationExpression;
            if (invocationExpression.invocation.channel === 'entity')
                return true;
            if (!hasFilter(node.filter, 'id') && !hasFilter(node.filter, 'instance_of')) {
                node.filter = new Ast.AndBooleanExpression(
                    null, 
                    [this._instanceOfFilter(invocationExpression), node.filter]
                );
            }
            invocationExpression.invocation.channel = 'entity';
        }
        return true;
    }

    visitEntityValue(value : Ast.EntityValue) : boolean {
        if (this._normalizeEntityTypes)
            value.type = 'org.wikidata:entity';
        else if (this._normalizeDomains !== 'never' && !value.type.startsWith('org.wikidata:p_')) 
            value.type = 'org.wikidata:entity';
        return true;
    }
}

interface PostProcessorOptions {
    tpClient : Tp.BaseClient;
    schemas : ThingTalk.SchemaRetriever;
    class : Ast.ClassDef;
    normalizeDomains : 'always'|'id-filtered-only'|'never';
    normalizeEntityTypes : boolean; 
    includeEntityValue : boolean;
    excludeEntityDisplay : boolean;
}

export class PostProcessor {
    private _tpClient : Tp.BaseClient;
    private _schemas : ThingTalk.SchemaRetriever;
    private _normalizer : NormalizerVisitor;
    private _includeEntityValue : boolean;
    private _excludeEntityDisplay : boolean;

    constructor(options : PostProcessorOptions) {
        this._tpClient = options.tpClient;
        this._schemas = options.schemas;
        this._normalizer = new NormalizerVisitor(options.class, options);
        this._includeEntityValue = options.includeEntityValue;
        this._excludeEntityDisplay = options.excludeEntityDisplay;
    }

    async postprocess(thingtalk : string, preprocessedUtterance : string) : Promise<string[]> {
        const entities = EntityUtils.makeDummyEntities(preprocessedUtterance);
        const program = await ThingTalkUtils.parsePrediction(thingtalk.split(' '), entities, {
            timezone : undefined,
            thingpediaClient: this._tpClient,
            schemaRetriever : this._schemas
        });
        // skip program that does not type check. 
        // TODO: fix typechecking
        if (!program)
            return thingtalk.split(' ');
        program.visit(this._normalizer);
        return ThingTalkUtils.serializePrediction(
            program, 
            preprocessedUtterance, 
            entities,
            { 
                locale: 'en', 
                timezone: undefined, 
                includeEntityValue: this._includeEntityValue, 
                excludeEntityDisplay: this._excludeEntityDisplay 
            }
        );
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Post process generated data"
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
        type: fs.createReadStream
    });
    parser.add_argument('-o', '--output', {
        required: true,
        type: fs.createWriteStream
    });
    parser.add_argument('--normalize-domains', {
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
        class: await schemas.getFullMeta('org.wikidata'),
        normalizeDomains: args.normalize_domains,
        normalizeEntityTypes: args.normalize_entity_types,
        includeEntityValue: args.include_entity_value,
        excludeEntityDisplay: args.exclude_entity_display
    });

    args.input.setEncoding('utf8').pipe(byline())
        .pipe(new DatasetParser({ contextual: false, preserveId: true }))
        .pipe(new Stream.Transform({
            objectMode: true,

            async transform(ex, encoding, callback) {
                try {
                    const postprocessed = await processor.postprocess(ex.target_code, ex.preprocessed);
                    ex.target_code = postprocessed.join(' ');
                    callback(null, ex);
                } catch(e) {
                    callback();
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

if (require.main === module)
    main();