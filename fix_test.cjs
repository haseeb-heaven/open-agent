const fs = require('fs');
let file = 'packages/core/src/routing/modelRouterService.test.ts';
let content = fs.readFileSync(file, 'utf8');

// The write_file step didn't succeed previously or it was deleted by git restore? Let's check.
content = content.replace("import { JevClassifierStrategy } from './strategies/jevClassifierStrategy.js';\n", "");
content = content.replace("vi.mock('./strategies/jevClassifierStrategy.js');\n", "");

content = content.replace(
`    expect(childStrategies.length).toBe(8);
    expect(childStrategies[0]).toBeInstanceOf(FallbackStrategy);
    expect(childStrategies[1]).toBeInstanceOf(OverrideStrategy);
    expect(childStrategies[2]).toBeInstanceOf(ApprovalModeStrategy);
    expect(childStrategies[3]).toBeInstanceOf(GemmaClassifierStrategy);
    expect(childStrategies[4]).toBeInstanceOf(JevClassifierStrategy);
    expect(childStrategies[5]).toBeInstanceOf(ClassifierStrategy);
    expect(childStrategies[6]).toBeInstanceOf(NumericalClassifierStrategy);
    expect(childStrategies[7]).toBeInstanceOf(DefaultStrategy);`,
`    expect(childStrategies.length).toBe(7);
    expect(childStrategies[0]).toBeInstanceOf(FallbackStrategy);
    expect(childStrategies[1]).toBeInstanceOf(OverrideStrategy);
    expect(childStrategies[2]).toBeInstanceOf(ApprovalModeStrategy);
    expect(childStrategies[3]).toBeInstanceOf(GemmaClassifierStrategy);
    expect(childStrategies[4]).toBeInstanceOf(ClassifierStrategy);
    expect(childStrategies[5]).toBeInstanceOf(NumericalClassifierStrategy);
    expect(childStrategies[6]).toBeInstanceOf(DefaultStrategy);`
);


content = content.replace(
`    expect(childStrategies.length).toBe(7);
    expect(childStrategies[0]).toBeInstanceOf(FallbackStrategy);
    expect(childStrategies[1]).toBeInstanceOf(OverrideStrategy);
    expect(childStrategies[2]).toBeInstanceOf(ApprovalModeStrategy);
    expect(childStrategies[3]).toBeInstanceOf(JevClassifierStrategy);
    expect(childStrategies[4]).toBeInstanceOf(ClassifierStrategy);
    expect(childStrategies[5]).toBeInstanceOf(NumericalClassifierStrategy);
    expect(childStrategies[6]).toBeInstanceOf(DefaultStrategy);`,
`    expect(childStrategies.length).toBe(6);
    expect(childStrategies[0]).toBeInstanceOf(FallbackStrategy);
    expect(childStrategies[1]).toBeInstanceOf(OverrideStrategy);
    expect(childStrategies[2]).toBeInstanceOf(ApprovalModeStrategy);
    expect(childStrategies[3]).toBeInstanceOf(ClassifierStrategy);
    expect(childStrategies[4]).toBeInstanceOf(NumericalClassifierStrategy);
    expect(childStrategies[5]).toBeInstanceOf(DefaultStrategy);`
);


fs.writeFileSync(file, content);
