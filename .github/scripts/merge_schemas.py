import json
import sys
import os

STANDALONE_DISTRIBUTION = "standalone"

def merge_schemas(distribution_files, output_file):
    """
    Merges multiple Rachis plugin schema JSON files into a single dictionary
    with a 'plugins' registry and a 'distributions' map.
    
    Args:
        distribution_files (dict): Map of distribution name to file path.
        output_file (str): Path to write the merged JSON.
    """
    final_schema = {
        "plugins": {},
        "distributions": {},
        "types": {}
    }
    
    for dist_name, filepath in distribution_files.items():
        if not os.path.exists(filepath):
            print(f"Warning: File {filepath} not found for distribution '{dist_name}'. Skipping.", file=sys.stderr)
            continue
            
        try:
            print(f"Processing {dist_name} from {filepath}...", file=sys.stderr)
            with open(filepath, 'r') as f:
                data = json.load(f)
                
                dist_plugins = []

                # Merge plugins into the main registry
                for plugin_name, plugin_content in data.items():
                    if dist_name == STANDALONE_DISTRIBUTION and plugin_name in final_schema["plugins"]:
                        print(
                            f"Warning: Standalone plugin '{plugin_name}' already exists in an official distribution. Skipping.",
                            file=sys.stderr
                        )
                        continue

                    dist_plugins.append(plugin_name)

                    if plugin_name not in final_schema["plugins"]:
                        # New plugin, add it whole
                        final_schema["plugins"][plugin_name] = plugin_content
                        if 'types' in plugin_content:
                             # 'types' is { TypeName: Description }
                             final_schema["types"].update(plugin_content['types'])
                    else:
                        # Existing plugin, merge actions
                        target_plugin = final_schema["plugins"][plugin_name]
                        
                        if 'actions' in plugin_content:
                            if 'actions' not in target_plugin:
                                target_plugin['actions'] = {}
                            
                            # precise merge for actions to avoid overwriting unrelated ones
                            # We update, but if same action exists we overwrite (assuming latest version)
                            # precise merge for actions to avoid overwriting unrelated ones
                            # We update, but if same action exists we overwrite (assuming latest version)
                            target_plugin['actions'].update(plugin_content['actions'])
                            
                        # Merge semantic types into top-level registry
                        if 'types' in plugin_content:
                             # 'types' is { TypeName: Description }
                             final_schema["types"].update(plugin_content['types'])

                # record plugins for this distribution after duplicate filtering
                final_schema["distributions"][dist_name] = {"plugins": dist_plugins}
                        
        except json.JSONDecodeError as e:
            print(f"Error decoding JSON from {filepath}: {e}", file=sys.stderr)
        except Exception as e:
            print(f"Unexpected error processing {filepath}: {e}", file=sys.stderr)

    # Write output
    try:
        output_dir = os.path.dirname(output_file)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        with open(output_file, 'w') as f:
            # Using no indent for smaller file size, consistent with compact JSON
            json.dump(final_schema, f, separators=(',', ':'))
        print(f"Successfully wrote merged schema to {output_file}", file=sys.stderr)
    except IOError as e:
        print(f"Error writing to {output_file}: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python merge_schemas.py <output_file> <dist_name=file_path> [dist_name=file_path ...]")
        print("Example: python merge_schemas.py schema.json moshpit=moshpit.json amplicon=amplicon.json")
        sys.exit(1)
    
    output_path = sys.argv[1]
    input_args = sys.argv[2:]
    
    dist_map = {}
    for arg in input_args:
        if '=' in arg:
            name, path = arg.split('=', 1)
            dist_map[name] = path
        else:
            # Fallback for old style or error
            print(f"Error: Argument '{arg}' invalid. Must be name=path", file=sys.stderr)
            sys.exit(1)
            
    merge_schemas(dist_map, output_path)
