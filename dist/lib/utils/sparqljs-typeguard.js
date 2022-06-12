"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAggregateExpression = exports.isUnionPattern = exports.isFilterPattern = exports.isBasicGraphPattern = exports.isUnaryPropertyPath = exports.isSequencePropertyPath = exports.isPropertyPath = exports.isLiteral = exports.isVariable = exports.isWikidataPropertyNode = exports.isWikidataEntityNode = exports.isNamedNode = void 0;
const wikidata_1 = require("./wikidata");
function isNamedNode(node) {
    return 'termType' in node && node.termType === 'NamedNode';
}
exports.isNamedNode = isNamedNode;
function isWikidataEntityNode(node) {
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(wikidata_1.ENTITY_PREFIX);
}
exports.isWikidataEntityNode = isWikidataEntityNode;
function isWikidataPropertyNode(node, pid) {
    if (pid)
        return 'termType' in node && node.termType === 'NamedNode' && node.value === wikidata_1.PROPERTY_PREFIX + pid;
    return 'termType' in node && node.termType === 'NamedNode' && node.value.startsWith(wikidata_1.PROPERTY_PREFIX);
}
exports.isWikidataPropertyNode = isWikidataPropertyNode;
function isVariable(node) {
    return 'termType' in node && node.termType === 'Variable';
}
exports.isVariable = isVariable;
function isLiteral(node) {
    return 'termType' in node && node.termType === 'Literal';
}
exports.isLiteral = isLiteral;
function isPropertyPath(node) {
    return 'pathType' in node && ['|', '/', '^', '+', '*', '!'].includes(node.pathType);
}
exports.isPropertyPath = isPropertyPath;
function isSequencePropertyPath(node) {
    return 'pathType' in node && node.pathType === '/' && node.items.length > 1;
}
exports.isSequencePropertyPath = isSequencePropertyPath;
function isUnaryPropertyPath(node, type) {
    if (type)
        return 'pathType' in node && node.pathType === type && node.items.length === 1;
    return 'pathType' in node && ['+', '*', '!'].includes(node.pathType) && node.items.length === 1;
}
exports.isUnaryPropertyPath = isUnaryPropertyPath;
function isBasicGraphPattern(node) {
    return 'type' in node && node.type === 'bgp';
}
exports.isBasicGraphPattern = isBasicGraphPattern;
function isFilterPattern(node) {
    return 'type' in node && node.type === 'filter';
}
exports.isFilterPattern = isFilterPattern;
function isUnionPattern(node) {
    return 'type' in node && node.type === 'union';
}
exports.isUnionPattern = isUnionPattern;
function isAggregateExpression(node, aggregation) {
    if (aggregation)
        return 'type' in node && node.type === 'aggregate' && node.aggregation === aggregation;
    return 'type' in node && node.type === 'aggregate';
}
exports.isAggregateExpression = isAggregateExpression;
//# sourceMappingURL=sparqljs-typeguard.js.map