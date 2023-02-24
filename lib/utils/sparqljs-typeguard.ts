import { 
    ENTITY_PREFIX, 
    PROPERTY_PREFIX,
    PROPERTY_PREDICATE_PREFIX,
    PROPERTY_QUALIFIER_PREFIX,
    PROPERTY_STATEMENT_PREFIX
} from './wikidata';
import { 
    IriTerm,
    VariableTerm,
    VariableExpression,
    LiteralTerm,
    PropertyPath,
    BgpPattern,
    FilterPattern,
    UnionPattern,
    AggregateExpression,
    OperationExpression,
    SelectQuery,
    AskQuery,
    ServicePattern
} from 'sparqljs';

export function isNamedNode(node : any) : node is IriTerm {
    return 'termType' in node && node.termType === 'NamedNode';
}

export function isWikidataEntityNode(node : any) : node is IriTerm {
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(ENTITY_PREFIX);
}

export function isWikidataPropertyNode(node : any, pid ?: string) : node is IriTerm {
    if (pid)
        return 'termType' in node && node.termType === 'NamedNode' && node.value === PROPERTY_PREFIX + pid;
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(PROPERTY_PREFIX);
}

export function isWikidataPredicateNode(node : any, pid ?: string) : node is IriTerm {
    return isWikidataPropertyStatementNode(node, pid) || isWikidataPropertyQualifierNode(node, pid) || isWikidataPropertyPredicateNode(node, pid);
}

export function isWikidataPropertyStatementNode(node : any, pid ?: string) : node is IriTerm {
    if (pid)
        return 'termType' in node && node.termType === 'NamedNode' && node.value === PROPERTY_STATEMENT_PREFIX + pid;
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(PROPERTY_STATEMENT_PREFIX); 
} 

export function isWikidataPropertyQualifierNode(node : any, pid ?: string) : node is IriTerm {
    if (pid)
        return 'termType' in node && node.termType === 'NamedNode' && node.value === PROPERTY_QUALIFIER_PREFIX + pid;
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(PROPERTY_QUALIFIER_PREFIX); 
} 

export function isWikidataPropertyPredicateNode(node : any, pid ?: string) : node is IriTerm {
    if (isWikidataPropertyNode(node) || isWikidataPropertyQualifierNode(node) || isWikidataPropertyStatementNode(node))
        return false;
    if (pid)
        return 'termType' in node && node.termType === 'NamedNode' && node.value === PROPERTY_PREDICATE_PREFIX + pid;
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(PROPERTY_PREDICATE_PREFIX); 
} 

export function isVariable(node : any) : node is VariableTerm {
    return 'termType' in node && node.termType === 'Variable';
}

export function isVariableExpression(node : any) : node is VariableExpression {
    return 'variable' in node && isVariable(node.variable) && 'expression' in node;
}

export function isLiteral(node : any) : node is LiteralTerm {
    return 'termType' in node && node.termType === 'Literal';
}

export function isPropertyPath(node : any) : node is PropertyPath {
    return 'pathType' in node && ['|', '/', '^', '+', '*', '!'].includes(node.pathType);
}

export function isSequencePropertyPath(node : any) : node is PropertyPath {
    return 'pathType' in node && node.pathType === '/' && node.items.length > 1;
}

export function isUnaryPropertyPath(node : any, type ?: '+'|'*'|'!') : node is PropertyPath {
    if (type)
        return 'pathType' in node && node.pathType === type && node.items.length === 1;
    return 'pathType' in node && ['+', '*', '!'].includes(node.pathType) && node.items.length === 1;
}

export function isBasicGraphPattern(node : any) : node is BgpPattern {
    return 'type' in node && node.type === 'bgp';
}

export function isFilterPattern(node : any) : node is FilterPattern {
    return 'type' in node && node.type === 'filter';
}

export function isUnionPattern(node : any) : node is UnionPattern {
    return 'type' in node && node.type === 'union';
}

export function isServicePattern(node : any) : node is ServicePattern {
    return 'type' in node && node.type === 'service';
}

export function isWikidataLabelServicePattern(node : any) : node is ServicePattern {
    return isServicePattern(node) && node.name.value === 'http://wikiba.se/ontology#label';
}

export function isAggregateExpression(node : any, aggregation ?: string) : node is AggregateExpression {
    if (aggregation)
        return 'type' in node && node.type === 'aggregate' && node.aggregation === aggregation;
    return 'type' in node && node.type === 'aggregate';
}

export function isOperationExpression(node : any) : node is OperationExpression {
    return 'type' in node && node.type === 'operation';
}

export function isSelectQuery(node : any) : node is SelectQuery {
    return 'queryType' in node && node.queryType === 'SELECT';
}

export function isAskQuery(node : any) : node is AskQuery {
    return 'queryType' in node && node.queryType === 'ASK';
}