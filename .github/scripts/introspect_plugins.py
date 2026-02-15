
import json
import os
import tempfile
import sys
import re

try:
    import qiime2.sdk
except ImportError as e:
    import sys
    print(f"ImportError: {e}", file=sys.stderr)
    print(json.dumps({}))
    sys.exit(0)

# Fix for Numba caching issue in some environments
os.environ["NUMBA_CACHE_DIR"] = tempfile.gettempdir()

 
data = {}

for name, plugin in pm.plugins.items():
    plugin_data = {'actions': {}}
    
    for action_name, action in plugin.actions.items():
        if action_name.startswith('_'):
            continue
        try:
            signature = action.signature
            
            def extract_types(qtype):
                results = set()
                
                def clean_name(s):
                    # Strip superscripts
                    s = re.sub(r'[¹²³⁴⁵⁶⁷⁸⁹⁰]', '', s)
                    # KEEP properties (user logic: properties matter)
                    return s

                def recurse(t):
                    # 1. Expand Union (Top Level)
                    if hasattr(t, 'members'):
                        for m in t.members:
                            recurse(m)
                        return

                    # 2. Expand Generic with Union Field (e.g. SampleData[A | B])
                    # Heuristic: Check field[0] for members
                    if hasattr(t, 'fields') and t.fields:
                        f0 = t.fields[0]
                        if hasattr(f0, 'members'):
                             # Extract outer name from string representation to be safe
                             s_repr = str(t)
                             match = re.match(r'^([\w\.]+)\[', s_repr)
                             if match:
                                 outer = match.group(1)
                                 for m in f0.members:
                                     # Recurse on member? Assume atomic Member for now or clean its string
                                     # If Member is Union, we'd need meaningful recursion but that's deeply nested.
                                     # For QIIME 2, usually A[B|C]. B, C are atomic.
                                     results.add(f"{outer}[{clean_name(str(m))}]")
                                 return
                    
                    # 3. Base case
                    results.add(clean_name(str(t)))

                recurse(qtype)
                return list(results)

            inputs = {}
            for k, v in signature.inputs.items():
                inputs[k] = {
                    'type': extract_types(v.qiime_type),
                    'required': not v.has_default()
                }
                
            parameters = {}
            for k, v in signature.parameters.items():
                parameters[k] = {
                    'type': str(v.qiime_type),
                    'required': not v.has_default()
                }
                
            outputs = {}
            for k, v in signature.outputs.items():
                 outputs[k] = {
                    'type': extract_types(v.qiime_type)
                 }

            plugin_data['actions'][action_name] = {
                'description': action.description,
                'inputs': inputs,
                'parameters': parameters,
                'outputs': outputs
            }
        except Exception as e:
            # Skip actions that fail reflection
            continue
            
    # Extract Semantic Types
    types = {}
    if hasattr(plugin, 'types'):
        for type_name, type_record in plugin.types.items():
            # type_record is likely the SemanticType class or similar
            # User wants description. 
            # In QIIME 2, types are registered objects. 
            # We need to see if we can get a description.
            # If not, we just list it.
            
            description = ""
            if hasattr(type_record, 'description'):
                description = type_record.description
            elif hasattr(type_record, '__doc__') and type_record.__doc__:
                description = type_record.__doc__
            
            # Clean up docstrings
            if description:
                description = description.strip()

            types[str(type_name)] = description

    plugin_data['types'] = types
    
    data[name] = plugin_data

print(json.dumps(data, default=str))
