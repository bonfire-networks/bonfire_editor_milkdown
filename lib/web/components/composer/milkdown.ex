defmodule Bonfire.Editor.Milkdown do
  use Bonfire.UI.Common.Web, :stateless_component

  prop smart_input_opts, :map, default: %{}
  prop field_name, :string, default: "post[post_content][html_body]", required: false
  prop textarea_class, :css_class, default: "w-full md:min-h-[280px] h-full"
  prop reset_smart_input, :boolean, default: false
  prop showing_within, :atom

  @doc "Identifies the submitted content format for consumers of this editor."
  def output_format, do: :markdown
end
